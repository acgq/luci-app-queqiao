'use strict';
'require rpc';
'require ui';

var listProfiles = rpc.declare({ object: 'luci.queqiao', method: 'profile_list', expect: {} });
var readProfile = rpc.declare({ object: 'luci.queqiao', method: 'profile_read', params: [ 'name' ], expect: {} });
var saveProfile = rpc.declare({ object: 'luci.queqiao', method: 'profile_save', params: [ 'name', 'content', 'revision' ], expect: {} });
var applyProfile = rpc.declare({ object: 'luci.queqiao', method: 'profile_apply', params: [ 'name', 'revision' ], expect: {} });
var deleteProfile = rpc.declare({ object: 'luci.queqiao', method: 'profile_delete', params: [ 'name', 'revision' ], expect: {} });

return L.Class.extend({
	open: function(name, copy, onSaved) {
		var load = name ? readProfile(name) : Promise.resolve({ ok: true, content: '', revision: '' });
		return load.then(function(data) {
			if (!data.ok || (name && !data.exists)) throw new Error(data.error || _('配置不存在，请刷新列表。'));
			var creating = !name || copy;
			var revision = creating ? '' : data.revision;
			var nameInput = E('input', {
				'class': 'cbi-input-text', 'type': 'text', 'aria-label': _('配置名称'),
				'maxlength': 128, 'readonly': creating ? null : true,
				'value': copy ? Array.from(name).slice(0, 32).join('') + '_copy' : (name || '')
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
				if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,47}$/u.test(chosenName) || new TextEncoder().encode(chosenName).length > 128) {
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
			ui.showModal(creating ? _('新建配置') : _('编辑配置'), [
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
			selected, controls, note
		]);
		update();
		return refresh().then(function() { return section; });
	}
});
