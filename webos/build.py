#!/usr/bin/env python3
"""Builds the LG webOS version of the home screen: TvHome-webos.ipk, the package LG's Developer Mode installs.

    python3 webos/build.py            # → TvHome-webos.ipk
    python3 webos/build.py --preview  # also leaves the files in webos/out/ to open index.html in a browser

Puts webos/app/, webos/appinfo.json, the icons and the JS service (webos/service/) together and packs them the way
LG's ares-package does (an ar archive with control.tar.gz and data.tar.gz), so no LG tools are needed. The dock uses
the Mi Box's wide app logos from launcher/assets/demo/ when they are there (kept out of git: brand logos).
Packaging adapted from Free My TV (github.com/simbasjungles/free-my-tv, MIT). Python 3 only.
"""
import io
import json
import os
import re
import shutil
import sys
import tarfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
IPK = os.path.join(ROOT, 'TvHome-webos.ipk')
OUT = os.path.join(HERE, 'out')
LOGOS = os.path.join(ROOT, 'launcher', 'assets', 'demo')
SKIP_LOGOS = {'playstore', 'livechannels'}   # Android-only apps


def read(path):
    with open(path, 'rb') as f:
        return f.read()


def app_files():
    """{path in the app: bytes}."""
    files = {}
    for name in sorted(os.listdir(os.path.join(HERE, 'app'))):
        files[name] = read(os.path.join(HERE, 'app', name))
    logos = {}
    if os.path.isdir(LOGOS):
        for name in sorted(os.listdir(LOGOS)):
            key = re.sub(r'^\d+_', '', os.path.splitext(name)[0])
            if name.endswith('.png') and key not in SKIP_LOGOS:
                files['logos/' + name] = read(os.path.join(LOGOS, name))
                logos[key] = 'logos/' + name
    files['config.js'] = ('var CONFIG = %s;\n' % json.dumps({'logos': logos}, indent=2)).encode('utf-8')
    for name in ('appinfo.json', 'icon.png', 'largeIcon.png'):
        files[name] = read(os.path.join(HERE, name))
    return files


def tar_gz(entries):
    """A .tar.gz from [(name, bytes or None for a directory)], owned by root, as ares-package makes them."""
    buf = io.BytesIO()
    now = int(time.time())
    with tarfile.open(fileobj=buf, mode='w:gz', format=tarfile.PAX_FORMAT) as tar:
        for name, data in entries:
            info = tarfile.TarInfo(name)
            info.mtime = now
            info.uid = info.gid = 0
            if data is None:
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                tar.addfile(info)
            else:
                info.size = len(data)
                info.mode = 0o644
                tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def ar(members):
    out = io.BytesIO()
    out.write(b'!<arch>\n')
    now = int(time.time())
    for name, data in members:
        out.write(('%-16s%-12d%-6d%-6d%-8s%-10d`\n' % (name, now, 0, 0, '100644', len(data))).encode('ascii'))
        out.write(data)
        if len(data) % 2:
            out.write(b'\n')
    return out.getvalue()


def build(preview):
    info = json.loads(read(os.path.join(HERE, 'appinfo.json')))
    app_id, version = info['id'], info['version']
    app = app_files()

    base = 'usr/palm/applications/' + app_id
    entries = [('usr', None), ('usr/palm', None), ('usr/palm/applications', None), (base, None)]
    dirs = set()
    for path in sorted(app):
        parent = os.path.dirname(path)
        if parent and parent not in dirs:
            dirs.add(parent)
            entries.append((base + '/' + parent, None))
        entries.append((base + '/' + path, app[path]))

    # The JS service: EssilorLuxottica's price, the RAM, and the TV's app list (webos/service).
    service_id = app_id + '.service'
    service = {'service.js': read(os.path.join(HERE, 'service', 'service.js')),
               'package.json': json.dumps({'name': service_id, 'version': version, 'main': 'service.js'},
                                          indent=2).encode('utf-8'),
               'services.json': json.dumps({'id': service_id, 'description': 'Accueil perso',
                                            'services': [{'name': service_id, 'description': 'Accueil perso'}]},
                                           indent=2).encode('utf-8')}
    service_base = 'usr/palm/services/' + service_id
    entries += [('usr/palm/services', None), (service_base, None)]
    entries += [(service_base + '/' + name, service[name]) for name in sorted(service)]

    package = json.dumps({'id': app_id, 'version': version, 'app': app_id, 'services': [service_id]},
                         indent=2).encode('utf-8')
    entries += [('usr/palm/packages', None), ('usr/palm/packages/' + app_id, None),
                ('usr/palm/packages/' + app_id + '/packageinfo.json', package)]

    size = sum(len(d) for d in app.values()) + sum(len(d) for d in service.values()) + len(package)
    control = ('Package: %s\nVersion: %s\nSection: misc\nPriority: optional\nArchitecture: all\nInstalled-Size: %d\n'
               'Maintainer: Sacha <https://github.com/sacha9214/mibox-launcher>\nDescription: Home screen.\n'
               'webOS-Package-Format-Version: 2\nwebOS-Packager-Version: 1.0.0\n' % (app_id, version, size))
    data = ar([('debian-binary', b'2.0\n'), ('control.tar.gz', tar_gz([('control', control.encode('utf-8'))])),
               ('data.tar.gz', tar_gz(entries))])
    with open(IPK, 'wb') as f:
        f.write(data)

    if preview:
        shutil.rmtree(OUT, ignore_errors=True)
        for path, content in app.items():
            os.makedirs(os.path.dirname(os.path.join(OUT, path)), exist_ok=True)
            with open(os.path.join(OUT, path), 'wb') as f:
                f.write(content)
        print('Preview: open webos/out/index.html in a browser.')
    logos = sum(1 for p in app if p.startswith('logos/'))
    print('Built %s (%s %s, %d KB, %d logos)' % (os.path.basename(IPK), app_id, version, len(data) // 1024, logos))


if __name__ == '__main__':
    build('--preview' in sys.argv)
