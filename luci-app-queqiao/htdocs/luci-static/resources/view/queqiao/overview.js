'use strict';
'require view';
'require form';
'require rpc';
'require poll';
'require ui';
'require queqiao.profile-editor as ProfileEditor';

var getStatus = rpc.declare({ object: 'luci.queqiao', method: 'status', expect: {} });
var serviceAction = rpc.declare({ object: 'luci.queqiao', method: 'action', params: [ 'action' ], expect: {} });

return view.extend({
	load: function() { return getStatus(); },

	render: function(initial) {
		var status = E('span');
		var version = E('small');
		var update = function(data) {
			status.textContent = data.running ? _('Running') : _('Stopped');
			status.style.color = data.running ? 'green' : 'red';
			version.textContent = data.version || _('Version unavailable');
		};
		update(initial);
		var controls = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ _('Service status'), ': ', status ]), E('p', {}, version)
		]);
		[ [ 'start', _('Start') ], [ 'stop', _('Stop') ], [ 'restart', _('Restart') ] ].forEach(function(item) {
			controls.appendChild(E('button', {
				'class': 'btn cbi-button cbi-button-action', 'style': 'margin-right: .5em',
				'disabled': !L.hasViewPermission() || null,
				'click': ui.createHandlerFn(this, function() {
					return serviceAction(item[0]).then(function(result) {
						if (result.code !== 0) throw new Error(_('Service action failed. Check the profile and system log.'));
						return getStatus().then(update);
					}).catch(function(err) { ui.addNotification(null, E('p', {}, err.message)); });
				})
			}, item[1]));
		}, this);

		var m = new form.Map('queqiao', _('Queqiao'),
			_('Paired WAN transport. Local SOCKS5 is for routing clients such as mihomo on this router.'));
		var s = m.section(form.NamedSection, 'main', 'queqiao', _('Client settings'));
		s.addremove = false;
		var o = s.option(form.Flag, 'enabled', _('Enable client'), _('Save & Apply starts or stops the configured client.'));
		o.rmempty = false;
		o = s.option(form.Value, 'socks_port', _('Local SOCKS5 port'), _('Listens on 127.0.0.1 only.'));
		o.datatype = 'port'; o.rmempty = false;
		o = s.option(form.Value, 'local_address', _('Physical outbound interface'), _('Use auto or if: followed by a Linux device name, for example if:wan.'));
		o.value('auto', _('Automatic')); o.rmempty = false;
		o.validate = function(section, value) {
			return value === 'auto' || /^if:[a-zA-Z0-9_.:-]{1,15}$/.test(value) || _('Use auto or if:DEVICE.');
		};
		o = s.option(form.ListValue, 'transport', _('Transport'));
		o.value('auto', _('QUIC with TLS/TCP fallback')); o.value('quic', 'QUIC'); o.value('tcp', 'TLS/TCP'); o.rmempty = false;
		o = s.option(form.Value, 'max_sessions', _('Maximum concurrent sessions'));
		o.datatype = 'range(1,4096)'; o.rmempty = false;
		o = s.option(form.ListValue, 'memory_limit', _('Go memory target'), _('Soft runtime target; total process memory can exceed it.'));
		[ '32MiB', '64MiB', '96MiB', '128MiB' ].forEach(function(v) { o.value(v); }); o.rmempty = false;
		o = s.option(form.ListValue, 'log_level', _('Log level'), _('Logs stay in RAM at /tmp/queqiao/client.log; two files of up to 1 MiB are retained.'));
		[ 'debug', 'info', 'warn', 'error' ].forEach(function(v) { o.value(v); }); o.rmempty = false;
		o = s.option(form.Flag, 'metrics', _('Enable local metrics')); o.rmempty = false;
		o = s.option(form.Value, 'metrics_port', _('Local metrics port'), _('Listens on 127.0.0.1 only; use a different port from SOCKS5.'));
		o.datatype = 'port'; o.depends('metrics', '1'); o.rmempty = false;
		o.validate = function(section, value) {
			return value !== this.map.lookupOption('socks_port', section)[0].formvalue(section) || _('Metrics and SOCKS5 ports must differ.');
		};
		poll.add(function() { return getStatus().then(update); }, 5);
		return Promise.all([ m.render(), ProfileEditor.render() ]).then(function(nodes) { return E('div', {}, [ controls, nodes[0], nodes[1] ]); });
	}
});
