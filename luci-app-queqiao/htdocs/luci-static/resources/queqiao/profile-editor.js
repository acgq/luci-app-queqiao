'use strict';
'require rpc';
'require ui';

var readProfile = rpc.declare({ object: 'luci.queqiao', method: 'profile_read', expect: {} });
var saveProfile = rpc.declare({ object: 'luci.queqiao', method: 'profile_save', params: [ 'content', 'revision' ], expect: {} });
var restart = rpc.declare({ object: 'luci.queqiao', method: 'action', params: [ 'action' ], expect: {} });

return L.Class.extend({
	open: function() {
		return readProfile().then(function(data) {
			if (!data.ok) throw new Error(data.error || _('Cannot load the device profile.'));
			var revision = data.revision;
			var editor = E('textarea', {
				'class': 'cbi-input-textarea', 'rows': 22, 'wrap': 'off',
				'aria-label': _('Device profile JSON'), 'spellcheck': 'false',
				'autocomplete': 'off', 'autocapitalize': 'off', 'style': 'width:100%;font-family:monospace'
			});
			editor.value = data.content || '';
			var message = E('p', { 'role': 'status' });
			var busy = false;
			var buttons = [];
			var setBusy = function(value) {
				busy = value;
				editor.disabled = value;
				buttons.forEach(function(button) { button.disabled = value; });
			};
			var save = function(shouldRestart) {
				if (busy) return;
				try { JSON.parse(editor.value); }
				catch (err) { message.textContent = _('Invalid JSON. Nothing was saved.'); return; }
				if (new TextEncoder().encode(editor.value).length > 65536) {
					message.textContent = _('The profile exceeds 64 KiB.'); return;
				}
				setBusy(true);
				message.textContent = _('Validating and saving…');
				return saveProfile(editor.value, revision).then(function(result) {
					if (!result.ok) throw new Error(result.error || _('Save failed.'));
					revision = result.revision;
					message.textContent = result.warning || _('Saved. Changed profiles keep one private backup at router.json.bak.');
					if (shouldRestart) return restart('restart').then(function(state) {
						if (state.code !== 0) throw new Error(_('Profile saved, but service restart failed.'));
						ui.hideModal();
					});
				}).catch(function(err) { message.textContent = err.message; }).finally(function() { setBusy(false); });
			};
			buttons.push(E('button', { 'class': 'btn', 'click': function() { if (!busy) ui.hideModal(); } }, _('Close')));
			buttons.push(E('button', { 'class': 'btn cbi-button-save', 'click': function() { return save(false); } }, _('Save profile')));
			buttons.push(E('button', { 'class': 'btn cbi-button-apply important', 'click': function() { return save(true); } }, _('Save and restart')));
			ui.showModal(_('Edit device profile'), [
				E('p', {}, _('Edit /etc/queqiao/router.json. This file contains the device private key. Access is restricted to the profile-management ACL.')),
				E('p', {}, _('JSON, certificate and identity checks run before saving. Concurrent renewal changes require reloading the editor. Enable the client in the main settings before restarting.')),
				editor, message, E('div', { 'class': 'right' }, buttons)
			], 'cbi-modal');
		}).catch(function(err) { ui.addNotification(null, E('p', {}, err.message)); });
	}
});
