#!/usr/bin/env python3
"""Installs the home screen on an LG TV in Developer Mode, over your Wi-Fi.

    python3 webos/install.py 192.168.1.120              # install or update, then open it
    python3 webos/install.py 192.168.1.120 --uninstall  # remove it

Before the first install, on the TV: install "Developer Mode" from the LG Content Store, sign in with a free LG
developer account (webostv.developer.lge.com), turn on Dev Mode Status (the TV restarts), then turn on Key Server.

The first time, this downloads the TV's key from its Key Server and asks for the passphrase the TV shows (type it
here; it is not stored). The unlocked key is kept in ~/.ssh/tvhome_webos_<IP>, so updates need neither. A key that
Free My TV's installer already unlocked for this TV (~/.ssh/freemytv_webos_<IP>) is used as is: it's the same key.
The app is copied over SSH (port 9922) and installed with the TV's own installer (com.webos.appInstallService).
Adapted from Free My TV's installer (github.com/simbasjungles/free-my-tv, MIT). Needs Python 3 and OpenSSH.
"""
import getpass
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
IPK = os.path.join(os.path.dirname(HERE), 'TvHome-webos.ipk')
with open(os.path.join(HERE, 'appinfo.json'), encoding='utf-8') as f:
    APP_ID = json.load(f)['id']
TEMP = '/media/developer/temp/tvhome.ipk'
SSH_OPTS = ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=' + os.devnull, '-o', 'LogLevel=ERROR',
            '-o', 'HostKeyAlgorithms=+ssh-rsa', '-o', 'PubkeyAcceptedKeyTypes=+ssh-rsa', '-p', '9922']


def key_path(ip, name='tvhome'):
    return os.path.join(os.path.expanduser('~'), '.ssh', '%s_webos_%s' % (name, ip.replace('.', '_')))


def fetch_key(ip):
    """The TV's SSH key from its Key Server, unlocked with the passphrase the TV shows."""
    for path in (key_path(ip), key_path(ip, 'freemytv')):
        if os.path.exists(path):
            return path
    path = key_path(ip)
    url = 'http://%s:9991/webos_rsa' % ip
    print('Getting the TV\'s key from %s ...' % url)
    try:
        with urllib.request.urlopen(url, timeout=6) as r:
            data = r.read()
    except Exception as e:
        sys.exit('Couldn\'t reach the Key Server (%s). In the TV\'s Developer Mode app, turn on Key Server.' % e)
    passphrase = getpass.getpass('Passphrase shown in Developer Mode on the TV: ').strip()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = tempfile.NamedTemporaryFile(delete=False)
    tmp.write(data)
    tmp.close()
    os.chmod(tmp.name, 0o600)
    unlock = subprocess.run(['ssh-keygen', '-p', '-P', passphrase, '-N', '', '-f', tmp.name], capture_output=True, text=True)
    if unlock.returncode != 0:
        os.unlink(tmp.name)
        reason = (unlock.stderr.strip().splitlines() or [''])[-1]
        sys.exit('That passphrase didn\'t unlock the key (%s). Check it on the TV (Developer Mode) and try again.' % reason)
    shutil.move(tmp.name, path)
    os.chmod(path, 0o600)
    return path


def ssh(ip, key, command, stdin=None, tty=False):
    args = ['ssh'] + (['-tt'] if tty else []) + SSH_OPTS + ['-i', key, 'prisoner@' + ip, command]
    return subprocess.run(args, stdin=stdin, capture_output=True, text=stdin is None)


def luna(ip, key, uri, payload, replies=1, wait=20):
    # luna-send-pub prints nothing without a terminal (-tt), and the installer streams several replies. Older webOS
    # ships BusyBox, whose timeout only takes -t SECS. Some (webOS 6) refuse the terminal: there -i streams the
    # replies without one, until the timeout.
    timeout = "if timeout -t 1 true 2>/dev/null; then T='timeout -t %d'; else T='timeout %d'; fi; " % (wait, wait)
    message = "%s '%s'" % (uri, json.dumps(payload, separators=(',', ':')))
    out = ssh(ip, key, timeout + '$T luna-send-pub -n %d %s' % (replies, message), tty=True).stdout or ''
    if not out.strip():
        out = ssh(ip, key, timeout + '$T luna-send-pub -i %s </dev/null' % message).stdout or ''
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if not args or not re.match(r'^\d{1,3}(\.\d{1,3}){3}$', args[0]):
        sys.exit(__doc__)
    ip = args[0]
    if not shutil.which('ssh') or not shutil.which('ssh-keygen'):
        sys.exit('OpenSSH (ssh and ssh-keygen) is needed.')
    key = fetch_key(ip)

    if '--uninstall' in sys.argv:
        out = luna(ip, key, 'luna://com.webos.appInstallService/dev/remove', {'id': APP_ID}, replies=3, wait=30)
        print('Removed.' if '"returnValue":true' in out else 'The TV said: ' + out.strip())
        return

    subprocess.run([sys.executable, os.path.join(HERE, 'build.py')], check=True)
    print('Copying the app to the TV ...')
    with open(IPK, 'rb') as f:
        copy = ssh(ip, key, 'mkdir -p /media/developer/temp && cat > ' + TEMP, stdin=f)
    if copy.returncode != 0:
        err = copy.stderr.decode('utf-8', 'replace') if isinstance(copy.stderr, bytes) else copy.stderr
        sys.exit('Couldn\'t copy it: %s\nIs Developer Mode still on? If the key changed, delete %s and try again.' % (err.strip(), key))
    print('Installing ...')
    out = luna(ip, key, 'luna://com.webos.appInstallService/dev/install', {'id': APP_ID, 'ipkUrl': TEMP, 'subscribe': True},
               replies=30, wait=60)
    if '"state":"installed"' not in out:
        sys.exit('The TV didn\'t finish installing. It said:\n' + out.strip())
    ssh(ip, key, 'rm -f ' + TEMP)
    luna(ip, key, 'luna://com.webos.applicationManager/launch', {'id': APP_ID})
    print('Installed and open on the TV.')
    print('Tip: while it is open, hold a number key on the remote to open it with that key from anywhere.')
    print('Developer Mode lasts about 40 days: open the Developer Mode app now and then and press EXTEND.')


if __name__ == '__main__':
    main()
