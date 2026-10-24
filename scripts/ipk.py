"""Write deterministic OpenWrt opkg IPKs (gzip tar, not renamed APKs)."""
import gzip
import io
from pathlib import Path, PurePosixPath
import tarfile


def _gzip(data):
    # GzipFile keeps the OS header portable across Python/zlib versions.
    output = io.BytesIO()
    with gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0) as stream:
        stream.write(data)
    return output.getvalue()


def _tar(entries, epoch):
    stream = io.BytesIO()
    directories = {'.'}
    for name in entries:
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or '\\' in name:
            raise ValueError('unsafe IPK payload path')
        directories.update(str(parent) for parent in path.parents)
    with tarfile.open(fileobj=stream, mode='w', format=tarfile.GNU_FORMAT) as archive:
        for name in sorted(directories):
            item = tarfile.TarInfo('./' if name == '.' else './' + name)
            item.type = tarfile.DIRTYPE
            item.mode = 0o700 if name == 'etc/queqiao' else 0o755
            item.uid = item.gid = 0
            item.mtime = epoch
            archive.addfile(item)
        for name, (data, mode) in sorted(entries.items()):
            item = tarfile.TarInfo('./' + name)
            item.mode, item.size, item.mtime = mode, len(data), epoch
            item.uid = item.gid = 0
            archive.addfile(item, io.BytesIO(data))
    return stream.getvalue()


def write_ipk(output, name, entries, version, arch, dependencies, epoch):
    version = version.replace('_git', '+git')
    arch = 'all' if arch == 'noarch' else arch
    payload = {
        key.removeprefix('root/'): value for key, value in entries.items()
        if key.startswith('root/') and not key.startswith('root/lib/apk/')
    }
    data_tar = _tar(payload, epoch)
    control = (
        f'Package: {name}\nVersion: {version}\nArchitecture: {arch}\n'
        'Maintainer: Queqiao OpenWrt contributors\n'
        f'Depends: {", ".join(dependencies.split())}\n'
        f'Installed-Size: {len(data_tar)}\nSection: net\nPriority: optional\n'
        'License: MIT\nSource: https://github.com/acgq/luci-app-queqiao\n'
        'Description: Queqiao OpenWrt development package\n'
    )
    if name == 'queqiao':
        control += 'Provides: queqiao-luci-api-v4\n'
    controls = {'control': (control.encode(), 0o644)}
    if name == 'queqiao':
        controls['conffiles'] = (b'/etc/config/queqiao\n/etc/queqiao/.keep\n', 0o644)
        controls['postinst'] = (b'''#!/bin/sh
[ -z "${IPKG_INSTROOT:-}" ] || exit 0
umask 077
mkdir -p /etc/queqiao
chmod 700 /etc/queqiao
if /etc/init.d/queqiao enabled; then
    /etc/init.d/queqiao restart
fi
exit 0
''', 0o755)
        controls['prerm'] = (b'''#!/bin/sh
[ -z "${IPKG_INSTROOT:-}" ] || exit 0
/etc/init.d/queqiao stop
[ "$1" != remove ] || /etc/init.d/queqiao disable
exit 0
''', 0o755)
    else:
        controls['postinst'] = entries.get('scripts/post-install', (b'#!/bin/sh\nexit 0\n', 0o755))
    members = {
        'debian-binary': (b'2.0\n', 0o644),
        'data.tar.gz': (_gzip(data_tar), 0o644),
        'control.tar.gz': (_gzip(_tar(controls, epoch)), 0o644),
    }
    path = Path(output) / f'{name}_{version}_{arch}.ipk'
    path.write_bytes(_gzip(_tar(members, epoch)))
    return path
