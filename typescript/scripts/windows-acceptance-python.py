"""Real WinVault acceptance operations restricted to a disposable example.invalid run."""
import hashlib
import json
from pathlib import Path
import re
import sys

CASES = ('interop', 'failure', 'collision', 'conflict', 'delete', 'races', 'concurrent', 'lock')
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
ACCOUNT = 'confluence-credentials'


def fixture(run_id, variant):
    if variant not in ('A', 'B', 'foreign-a', 'foreign-b'):
        raise ValueError()
    return {'username': 'acceptance-' + run_id + '-' + variant,
            'password': 'synthetic-' + run_id + '-' + variant + '-中文😀\\"'}


def scope(request):
    run_id, case = request.get('run_id'), request.get('case')
    if not isinstance(run_id, str) or not UUID.fullmatch(run_id) or case not in CASES:
        raise ValueError()
    base = 'https://windows-credential-check.example.invalid/' + run_id + '/' + case
    service = 'confluence-mcp:' + hashlib.sha256(base.encode('utf-8')).hexdigest()
    return run_id, base, service


def main():
    request = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    if sys.platform != 'win32':
        raise RuntimeError('WINDOWS_REQUIRED')
    from importlib.metadata import version
    if version('keyring') != '25.6.0':
        raise RuntimeError('PYTHON_KEYRING_VERSION')
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'native' / 'src'))
    from confluence_mcp.auth import backend, _save_record, _service, get_credentials
    store = backend()
    if request.get('mode') == 'probe':
        return {'ok': True, 'keyring': '25.6.0', 'backend': 'WinVaultKeyring'}
    run_id, base, service = scope(request)
    if _service(base) != service:
        raise RuntimeError('SERVICE_MISMATCH')
    targets = (service, ACCOUNT + '@' + service)
    accounts = {'own': ACCOUNT, 'foreign-a': 'acceptance-foreign-' + run_id + '-a',
                'foreign-b': 'acceptance-foreign-' + run_id + '-b'}

    def checked(target):
        value = store._read_credential(target)
        if value is not None:
            if value['UserName'] not in accounts.values() or json.loads(value.value) not in [fixture(run_id, v) for v in ('A', 'B', 'foreign-a', 'foreign-b')]:
                raise RuntimeError('SCOPE_OCCUPIED')
        return value

    # Even cleanup refuses to mutate a record not recognized as this run's synthetic data.
    for target in targets:
        checked(target)
    mode = request.get('mode')
    if mode == 'empty':
        if any(checked(target) is not None for target in targets):
            raise RuntimeError('SCOPE_OCCUPIED')
    elif mode == 'seed':
        slot = request.get('slot')
        if slot not in (0, 1) or type(slot) is not int or request.get('account') not in accounts:
            raise ValueError()
        store._set_password(targets[slot], accounts[request['account']], json.dumps(fixture(run_id, request['variant']), ensure_ascii=False))
    elif mode == 'save':
        _save_record(store, service, json.dumps(fixture(run_id, request['variant']), ensure_ascii=False))
    elif mode == 'read':
        if get_credentials(base) != tuple(fixture(run_id, request['variant'])[k] for k in ('username', 'password')):
            raise RuntimeError('READ_MISMATCH')
    elif mode == 'slot':
        slot = request.get('slot')
        if slot not in (0, 1) or type(slot) is not int:
            raise ValueError()
        value = checked(targets[slot])
        if request.get('variant') is None:
            if value is not None:
                raise RuntimeError('SLOT_NOT_EMPTY')
        elif value is None or value['UserName'] != accounts.get(request.get('account')) or json.loads(value.value) != fixture(run_id, request['variant']):
            raise RuntimeError('SLOT_MISMATCH')
    elif mode == 'native_failure':
        before = checked(service)
        if before is None or before['UserName'] != ACCOUNT:
            raise RuntimeError('MISSING_FIXTURE')
        try:
            _save_record(store, service, 'x' * 3000)  # 6,000 bytes exceeds the WinCred blob limit.
        except Exception as error:
            native = getattr(error, 'funcname', '') == 'CredWrite' and isinstance(getattr(error, 'winerror', None), int)
            after = checked(service)
            if after is None or after.value != before.value or after['UserName'] != before['UserName']:
                raise RuntimeError('FAILED_SAVE_CHANGED_RECORD')
            return {'ok': True, 'native_api_failure': native,
                    'code': getattr(error, 'winerror', None) if native else None}
        raise RuntimeError('INVALID_WRITE_SUCCEEDED')
    elif mode == 'delete':
        if store.get_password(service, ACCOUNT) is not None:
            store.delete_password(service, ACCOUNT)
    elif mode == 'cleanup':
        for target in targets:
            value = checked(target)
            if value is not None:
                store._delete_password(target)
        if any(checked(target) is not None for target in targets):
            raise RuntimeError('CLEANUP_INCOMPLETE')
    else:
        raise ValueError()
    return {'ok': True}


if __name__ == '__main__':
    try:
        print(json.dumps(main(), ensure_ascii=True))
    except Exception as error:
        allowed = {'WINDOWS_REQUIRED', 'PYTHON_KEYRING_VERSION', 'SERVICE_MISMATCH', 'SCOPE_OCCUPIED',
                   'READ_MISMATCH', 'SLOT_NOT_EMPTY', 'SLOT_MISMATCH', 'MISSING_FIXTURE',
                   'FAILED_SAVE_CHANGED_RECORD', 'INVALID_WRITE_SUCCEEDED', 'CLEANUP_INCOMPLETE'}
        code = str(error) if str(error) in allowed else 'PYTHON_ACCEPTANCE_FAILED'
        print(json.dumps({'ok': False, 'code': code}))
        sys.exit(1)
