'use strict';
'require rpc';
'require ui';

var check = rpc.declare({ object: 'luci.queqiao', method: 'check_connectivity', params: [ 'target' ], expect: {} });

return L.Class.extend({
	render: function() {
		var selected = E('select', { 'class': 'cbi-input-select', 'aria-label': _('检查目标') }, [
			E('option', { 'value': 'google' }, 'Google'),
			E('option', { 'value': 'ip_sb' }, 'ip.sb')
		]);
		var output = E('div', { 'role': 'status', 'style': 'margin-top:1em;white-space:pre-wrap' }, _('尚未检查。'));
		var button = E('button', {
			'class': 'btn cbi-button-action', 'type': 'button', 'style': 'margin-left:.5em',
			'disabled': !L.hasViewPermission() || null,
			'click': ui.createHandlerFn(this, function() {
				selected.disabled = true; button.disabled = true;
				output.textContent = _('正在通过当前 Queqiao 代理检查，最长等待 15 秒…');
				return check(selected.value).then(function(result) {
					var lines = [ result.ok ? _('检查通过') : (result.reachable ? _('目标可达，响应不符合预期') : _('检查未通过')) ];
					if (result.target) lines.push(_('目标：') + result.target);
					if (result.http_status) lines.push('HTTP ' + result.http_status);
					if (result.elapsed_ms != null) lines.push(_('耗时：') + result.elapsed_ms + ' ms');
					if (result.exit_ip) lines.push(_('出口 IP：') + result.exit_ip);
					if (result.error) lines.push(result.error);
					output.textContent = lines.join('\n');
				}).catch(function(err) { output.textContent = _('检查调用失败：') + err.message; }).finally(function() {
					selected.disabled = false; button.disabled = !L.hasViewPermission();
				});
			})
		}, _('检查代理连通性'));
		return E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('代理连通性检查')),
			E('p', {}, _('请求由路由器通过当前运行的 SOCKS5 代理发出，不会直连回退。检查所选目标，不代表所有网站或 UDP 都可用。')),
			selected, button, output
		]);
	}
});
