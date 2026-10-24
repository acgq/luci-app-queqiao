'use strict';
'require rpc';
'require ui';

var listProfiles = rpc.declare({ object: 'luci.queqiao', method: 'profile_list', expect: {} });
var readProfile = rpc.declare({ object: 'luci.queqiao', method: 'profile_read', params: [ 'name' ], expect: {} });
var saveProfile = rpc.declare({ object: 'luci.queqiao', method: 'profile_save', params: [ 'name', 'content', 'revision' ], expect: {} });
var applyProfile = rpc.declare({ object: 'luci.queqiao', method: 'profile_apply', params: [ 'name', 'revision' ], expect: {} });
var deleteProfile = rpc.declare({ object: 'luci.queqiao', method: 'profile_delete', params: [ 'name', 'revision' ], expect: {} });

function validProfileName(name) {
	return typeof name === 'string' && /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,47}$/u.test(name) && new TextEncoder().encode(name).length <= 128;
}

function downloadProfileJSON(name, content) {
	var url = URL.createObjectURL(new Blob([ content ], { type: 'application/json;charset=utf-8' }));
	var link = E('a', { 'href': url, 'download': name, 'style': 'display:none' });
	try { document.body.appendChild(link); link.click(); }
	finally {
		link.remove();
		window.setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
	}
}

return L.Class.extend({
	exportAll: function() {
		var initial;
		var profiles = [];
		return listProfiles().then(function(data) {
			if (!data.ok) throw new Error(data.error || _('无法读取配置库。'));
			initial = data;
			if (!Array.isArray(data.profiles) || !data.profiles.length || data.profiles.length > 32)
				throw new Error(_('配置库为空或配置数量无效，无法导出。'));
			return data.profiles.reduce(function(chain, item) {
				return chain.then(function() { return readProfile(item.name); }).then(function(profile) {
					if (!profile.ok || !profile.exists) throw new Error(profile.error || _('配置不存在，请刷新后重试。'));
					if (profile.revision !== item.revision) throw new Error(_('配置库在导出期间发生变化，请重试。'));
					if (typeof profile.content !== 'string' || !profile.content.length || new TextEncoder().encode(profile.content).length > 65536)
						throw new Error(_('配置内容无效或超过 64 KiB，未生成备份。'));
					profiles.push({ name: item.name, content: profile.content });
				});
			}, Promise.resolve());
		}).then(function() { return listProfiles(); }).then(function(current) {
			if (!current.ok) throw new Error(current.error || _('无法核对配置库。'));
			if (current.active !== initial.active || !Array.isArray(current.profiles) || current.profiles.length !== initial.profiles.length ||
				!initial.profiles.every(function(item) { return current.profiles.some(function(now) { return now.name === item.name && now.revision === item.revision; }); }))
				throw new Error(_('配置库在导出期间发生变化，请重试；没有下载不完整的备份。'));
			var stamp = new Date().toISOString();
			downloadProfileJSON('queqiao-profiles-' + stamp.slice(0, 19).replace(/[-:T]/g, '') + 'Z.json', JSON.stringify({
				format: 'queqiao-profile-library', version: 1, exported_at: stamp,
				active_profile: initial.active || '', profiles: profiles
			}, null, 2) + '\n');
			return profiles.length;
		});
	},

	importLibrary: function(backup, onSaved) {
		var names = new Set();
		if (backup.format !== 'queqiao-profile-library' || backup.version !== 1 || !Array.isArray(backup.profiles) || !backup.profiles.length || backup.profiles.length > 32)
			return Promise.reject(new Error(_('备份格式或版本不受支持，须包含 1–32 份配置。')));
		try {
			backup.profiles.forEach(function(item) {
				if (!item || !validProfileName(item.name) || names.has(item.name) || typeof item.content !== 'string' || !item.content.length || new TextEncoder().encode(item.content).length > 65536)
					throw new Error(_('备份含无效或重复的名称、空配置或超过 64 KiB 的配置。'));
				var value;
				try { value = JSON.parse(item.content); } catch (err) { throw new Error(_('备份含无效的配置 JSON。')); }
				if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(_('每份配置必须是 JSON 对象。'));
				names.add(item.name);
			});
		} catch (err) { return Promise.reject(err); }
		return listProfiles().then(function(current) {
			if (!current.ok) throw new Error(current.error || _('无法读取配置库。'));
			var existing = current.profiles || [];
			var busy = false;
			var closed = false;
			var prefix = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'maxlength': 128, 'aria-label': _('名称前缀（可选）') });
			var summary = E('p', { 'role': 'status' });
			var results = E('div', { 'role': 'status' });
			var preview = E('ul');
			var plan = function() {
				return backup.profiles.map(function(item) {
					var name = prefix.value + item.name;
					return { source: item, name: name, skip: existing.some(function(other) { return other.name === name; }) };
				});
			};
			var cancel = E('button', { 'type': 'button', 'class': 'btn', 'click': function() {
				if (busy) return;
				closed = true; backup.profiles.forEach(function(item) { item.content = ''; });
				ui.hideModal();
			} }, _('关闭'));
			var update = function() {
				var entries = plan();
				var invalid = entries.some(function(item) { return !validProfileName(item.name); });
				var added = entries.filter(function(item) { return !item.skip; }).length;
				preview.replaceChildren();
				entries.forEach(function(item) { preview.appendChild(E('li', {}, item.name + (item.skip ? _('（同名，跳过）') : _('（新草稿）')))); });
				summary.textContent = invalid ? _('加上前缀后的名称无效，请缩短或修改前缀。') :
					(existing.length + added > 32 ? _('导入后将超过 32 份配置上限，请先整理配置库。') :
					_('将新增草稿：') + added + _('；跳过同名：') + (entries.length - added));
				start.disabled = busy || invalid || !added || existing.length + added > 32;
			};
			var start = E('button', { 'type': 'button', 'class': 'btn cbi-button-save important', 'click': function() {
				if (busy || start.disabled) return;
				var created = [], failures = [], skipped = 0;
				busy = true; prefix.disabled = cancel.disabled = start.disabled = true;
				results.replaceChildren();
				return listProfiles().then(function(latest) {
					if (!latest.ok) throw new Error(latest.error || _('无法读取配置库。'));
					existing = latest.profiles || [];
					var entries = plan();
					if (entries.some(function(item) { return !validProfileName(item.name); }) || existing.length + entries.filter(function(item) { return !item.skip; }).length > 32)
						throw new Error(_('配置库已变化或名称无效，请检查导入预览后重试。'));
					return entries.reduce(function(chain, item, index) {
						return chain.then(function() {
							if (item.skip) { skipped++; return; }
							summary.textContent = _('正在导入：') + (index + 1) + '/' + entries.length;
							return saveProfile(item.name, item.source.content, '').then(function(result) {
								if (!result.ok) throw new Error(result.error || _('保存失败。'));
								created.push(item.name);
							}).catch(function(err) { failures.push({ name: item.name, error: err.message }); });
						});
						}, Promise.resolve());
				}).then(function() {
					results.appendChild(E('p', {}, _('导入结束：成功 ') + created.length + _('，跳过 ') + skipped + _('，失败 ') + failures.length + _('。当前连接未切换。')));
					failures.forEach(function(item) { results.appendChild(E('p', {}, item.name + '：' + item.error)); });
					return onSaved(created[0]);
				}).then(function() { return listProfiles(); }).then(function(latest) {
					if (latest.ok) existing = latest.profiles || [];
				}).catch(function(err) { results.appendChild(E('p', {}, err.message)); }).finally(function() {
					busy = false; prefix.disabled = cancel.disabled = false;
					if (!closed) update();
				});
			} }, _('导入备份草稿'));
			prefix.addEventListener('input', update);
			ui.showModal(_('导入全部配置备份'), [
				E('p', {}, _('备份中的配置将逐份校验并保存为草稿；同名跳过，不覆盖、不删除现有配置，也不会自动应用。')),
				E('p', {}, _('可添加统一名称前缀以另存为副本。若部分失败，已成功导入的草稿会保留，并逐项列出错误，可修正后重试。')),
				E('p', {}, _('备份记录的应用配置：') + (typeof backup.active_profile === 'string' ? backup.active_profile.slice(0, 128) : _('未记录')) + _('（仅供参考，导入后仍需手动应用）')),
				E('label', {}, [ _('名称前缀（可选）'), ' ', prefix ]), preview, summary, results,
				E('div', { 'class': 'right' }, [ cancel, ' ', start ])
			]);
			update();
		});
	},

	importFile: function(onSaved) {
		var self = this;
		var busy = false;
		var fileInput = E('input', {
			'type': 'file', 'accept': '.json,application/json', 'aria-label': _('选择配置 JSON 文件')
		});
		var message = E('p', { 'role': 'status' });
		var cancel = E('button', { 'type': 'button', 'class': 'btn', 'click': function() {
			if (!busy) { fileInput.value = ''; ui.hideModal(); }
		} }, _('取消'));
		var load = E('button', { 'type': 'button', 'class': 'btn cbi-button-action important', 'disabled': true, 'click': function() {
			if (busy) return;
			var file = fileInput.files && fileInput.files[0];
			if (!file || file.size < 1 || file.size > 16777216) {
				message.textContent = _('请选择 1 字节至 16 MiB 的 UTF-8 JSON 文件；单份配置最大 64 KiB。'); return;
			}
			busy = true; load.disabled = cancel.disabled = fileInput.disabled = true;
			message.textContent = _('正在读取文件…');
			return file.arrayBuffer().then(function(buffer) {
				var content;
				try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
				catch (err) { throw new Error(_('文件必须使用 UTF-8 编码。')); }
				try {
					var value = JSON.parse(content);
					if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
				}
				catch (err) { throw new Error(_('文件必须包含有效的 JSON 配置对象，尚未上传或保存。')); }
				if ('format' in value || 'profiles' in value) {
					return self.importLibrary(value, onSaved).then(function() { fileInput.value = ''; });
				}
				if (file.size > 65536) throw new Error(_('单份配置不能超过 64 KiB。'));
				var name = Array.from(file.name.replace(/\.json$/i, '').replace(/[^\p{L}\p{N}_-]/gu, '_').replace(/^[_-]+/, '')).slice(0, 48).join('');
				while (new TextEncoder().encode(name).length > 128) name = Array.from(name).slice(0, -1).join('');
				fileInput.value = ''; ui.hideModal();
				return self.open(null, false, onSaved, { name: name, content: content });
			}).catch(function(err) { message.textContent = err.message; }).finally(function() {
				busy = false; cancel.disabled = fileInput.disabled = false;
				load.disabled = !(fileInput.files && fileInput.files.length);
			});
		} }, _('载入文件'));
		fileInput.addEventListener('change', function() {
			load.disabled = !(fileInput.files && fileInput.files.length);
			message.textContent = '';
		});
		ui.showModal(_('导入配置文件'), [
			E('p', {}, _('可选择单份配置（最大 64 KiB），或“导出全部”生成的备份（最大 16 MiB、32 份配置）。文件使用 UTF-8 JSON；载入后再确认保存。')),
			E('p', {}, _('单份配置同名拒绝；备份同名跳过，也可统一添加前缀。导入只保存草稿，不会切换当前连接。')),
			fileInput, message, E('div', { 'class': 'right' }, [ cancel, ' ', load ])
		]);
	},

	exportFile: function(name) {
		return readProfile(name).then(function(data) {
			if (!data.ok || !data.exists) throw new Error(data.error || _('配置不存在，请刷新列表。'));
			if (typeof data.content !== 'string' || new TextEncoder().encode(data.content).length > 65536)
				throw new Error(_('配置内容无效或超过 64 KiB，无法导出。'));
			downloadProfileJSON(name + '.json', data.content);
		});
	},

	open: function(name, copy, onSaved, imported) {
		var load = imported ? Promise.resolve({ ok: true, content: imported.content, revision: '' }) :
			(name ? readProfile(name) : Promise.resolve({ ok: true, content: '', revision: '' }));
		return load.then(function(data) {
			if (!data.ok || (name && !data.exists)) throw new Error(data.error || _('配置不存在，请刷新列表。'));
			var creating = !name || copy;
			var revision = creating ? '' : data.revision;
			var nameInput = E('input', {
				'class': 'cbi-input-text', 'type': 'text', 'aria-label': _('配置名称'),
				'maxlength': 128, 'readonly': creating ? null : true,
				'value': copy ? Array.from(name).slice(0, 32).join('') + '_copy' : (imported ? imported.name : (name || ''))
			});
			var editor = E('textarea', {
				'class': 'cbi-input-textarea', 'rows': 22, 'wrap': 'off',
				'aria-label': _('配置 JSON'), 'spellcheck': 'false', 'autocomplete': 'off',
				'autocapitalize': 'off', 'style': 'width:100%;font-family:monospace'
			});
			editor.value = data.content || '';
			var message = E('p', { 'role': 'status' });
			var busy = false;
			var close = E('button', { 'class': 'btn', 'click': function() {
				if (!busy) { editor.value = ''; ui.hideModal(); }
			} }, _('取消'));
			var save = E('button', { 'class': 'btn cbi-button-save important', 'click': function() {
				if (busy) return;
				var chosenName = nameInput.value;
				if (!validProfileName(chosenName)) {
					message.textContent = _('名称须为 1–48 个字母、汉字或数字，可包含下划线和短横线，并以字母、汉字或数字开头。'); return;
				}
				try { JSON.parse(editor.value); }
				catch (err) { message.textContent = _('JSON 格式无效，配置尚未保存。'); return; }
				if (new TextEncoder().encode(editor.value).length > 65536) { message.textContent = _('配置不能超过 64 KiB。'); return; }
				busy = true; save.disabled = close.disabled = editor.disabled = nameInput.disabled = true;
				message.textContent = _('正在校验并保存，当前连接不会切换…');
				return saveProfile(chosenName, editor.value, revision).then(function(result) {
					if (!result.ok) throw new Error(result.error || _('保存失败。'));
					editor.value = ''; ui.hideModal();
					return onSaved(chosenName);
				}).catch(function(err) { message.textContent = err.message; }).finally(function() {
					busy = false; save.disabled = close.disabled = editor.disabled = nameInput.disabled = false;
				});
			} }, _('保存配置'));
			ui.showModal(imported ? _('导入配置') : (creating ? _('新建配置') : _('编辑配置')), [
				E('p', {}, _('保存只更新配置库。关闭编辑器后，点击“应用所选配置”才会切换并重启客户端。')),
				E('p', {}, _('JSON 内含设备私钥，只有配置管理权限可以读取。')),
				E('label', {}, [ _('配置名称'), ' ', nameInput ]), editor, message,
				E('div', { 'class': 'right' }, [ close, ' ', save ])
			], 'cbi-modal');
		}).catch(function(err) { ui.addNotification(null, E('p', {}, err.message)); });
	},

	render: function() {
		var self = this;
		var all = [];
		var busy = false;
		var active = E('p');
		var activeName = '';
		var note = E('p', { 'role': 'status' });
		var selected = E('select', { 'class': 'cbi-input-select', 'aria-label': _('选择配置') });
		var buttons = [];
		var canWrite = !!L.hasViewPermission();
		var update = function() {
			selected.disabled = busy || !all.length;
			buttons.forEach(function(button) { button.disabled = busy || !canWrite || (button.dataset.needsProfile && !selected.value); });
		};
		var refresh = function(preferred) {
			var previous = preferred || selected.value;
			return listProfiles().then(function(data) {
				if (!data.ok) throw new Error(data.error || _('无法读取配置库。'));
				all = data.profiles || [];
				activeName = data.active;
				selected.replaceChildren();
				all.forEach(function(item) {
					var label = item.name;
					if (item.name === data.active) label += _('（当前应用）');
					if (item.pending) label += _('（有未应用修改）');
					selected.appendChild(E('option', { 'value': item.name }, label));
				});
				if (all.some(function(item) { return item.name === previous; })) selected.value = previous;
				else if (all.some(function(item) { return item.name === data.active; })) selected.value = data.active;
				active.textContent = _('当前应用配置：') + (data.active || _('尚未应用'));
				note.textContent = _('已保存配置数量：') + all.length + '/32。' + _('选择和保存不会切换连接，请手动应用。');
				update();
			}).catch(function(err) { note.textContent = err.message; update(); });
		};
		selected.addEventListener('change', update);
		var addButton = function(label, needsProfile, action, important) {
			var button = E('button', {
				'class': 'btn ' + (important ? 'cbi-button-apply important' : 'cbi-button-action'),
				'style': 'margin: .5em .5em 0 0', 'type': 'button',
				'click': ui.createHandlerFn(self, action)
			}, label);
			if (needsProfile) button.dataset.needsProfile = '1';
			buttons.push(button); return button;
		};
		var controls = E('div', {}, [
			addButton(_('新建配置'), false, function() { return self.open(null, false, refresh); }),
			addButton(_('导入文件'), false, function() { return self.importFile(refresh); }),
			addButton(_('导出全部'), true, function() {
				if (busy) return;
				busy = true; update(); note.textContent = _('正在读取并核对整个配置库…');
				return self.exportAll().then(function(count) {
					note.textContent = _('已请求下载全部配置备份，共 ') + count + _(' 份。含设备私钥，请妥善保管。');
				}).catch(function(err) { note.textContent = err.message; }).finally(function() { busy = false; update(); });
			}),
			addButton(_('导出所选'), true, function() {
				if (busy || !selected.value) return;
				var name = selected.value;
				busy = true; update(); note.textContent = _('正在读取已保存的配置…');
				return self.exportFile(name).then(function() {
					note.textContent = _('已请求下载：') + name + '.json。' + _('导出的是已保存草稿，可能包含未应用修改；文件含设备私钥，请妥善保管。');
				}).catch(function(err) { note.textContent = err.message; }).finally(function() { busy = false; update(); });
			}),
			addButton(_('复制所选'), true, function() { return self.open(selected.value, true, refresh); }),
			addButton(_('编辑所选'), true, function() { return self.open(selected.value, false, refresh); }),
			addButton(_('删除所选'), true, function() {
				var chosen = all.find(function(item) { return item.name === selected.value; });
				if (!chosen || busy) return;
				if (chosen.name === activeName) {
					note.textContent = _('不能删除当前应用的配置，请先应用其他配置。'); return;
				}
				var message = E('p', { 'role': 'status' });
				var cancel = E('button', { 'class': 'btn', 'click': function() { ui.hideModal(); } }, _('取消'));
				var confirm = E('button', { 'class': 'btn cbi-button-negative important', 'click': function() {
					if (busy) return;
					busy = true; update(); confirm.disabled = cancel.disabled = true;
					message.textContent = _('正在删除…');
					return deleteProfile(chosen.name, chosen.revision).then(function(result) {
						if (!result.ok) throw new Error(result.error || _('删除失败。'));
						ui.hideModal();
						return refresh().then(function() { note.textContent = result.warning || _('已删除配置：') + chosen.name; });
					}).catch(function(err) { message.textContent = err.message; }).finally(function() {
						busy = false; update(); confirm.disabled = cancel.disabled = false;
					});
				} }, _('确认删除'));
				ui.showModal(_('删除配置'), [
					E('p', {}, _('将永久删除配置“') + chosen.name + _('”及其草稿、运行副本和相关备份。此操作不可恢复，当前连接不会切换。')),
					message, E('div', { 'class': 'right' }, [ cancel, ' ', confirm ])
				]);
			}),
			addButton(_('应用所选配置'), true, function() {
				var chosen = all.find(function(item) { return item.name === selected.value; });
				if (!chosen || busy) return;
				busy = true; update(); note.textContent = _('正在校验并应用配置，客户端将重启…');
				return applyProfile(chosen.name, chosen.revision).then(function(result) {
					if (!result.ok) throw new Error(result.error || _('应用失败。'));
					return refresh(chosen.name).then(function() {
						note.textContent = result.warning || (result.running ? _('配置已应用，客户端已启动。') : _('配置已应用；客户端当前未运行，请检查启用状态和系统日志。'));
					});
				}).catch(function(err) { note.textContent = err.message; }).finally(function() { busy = false; update(); });
			}, true),
			addButton(_('刷新列表'), false, function() { return refresh(); })
		]);
		var section = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('配置文件')), active,
			E('p', {}, _('每份配置独立保存；同一时间只运行手动应用的那一份。')),
			E('p', {}, _('“导出全部”备份所有已保存配置及名称；支持整包导入，保留“导出所选”。JSON 含设备私钥，请勿公开分享。')),
			selected, controls, note
		]);
		update();
		return refresh().then(function() { return section; });
	}
});
