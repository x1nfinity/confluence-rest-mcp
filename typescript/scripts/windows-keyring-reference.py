"""Pinned Python WinVault semantics against synthetic in-memory records, never an OS backend."""
import base64
import json
import sys
import types

state = json.load(sys.stdin)


class BackendError(Exception):
    def __init__(self, code, function):
        self.winerror, self.funcname = code, function


records = {item['target']: dict(Type=1, TargetName=item['target'], UserName=item['account'],
           CredentialBlob=base64.b64decode(item['blob'])) for item in state['records']}


def read(Type, TargetName):
    assert Type == 1
    if TargetName not in records:
        raise BackendError(1168, 'CredRead')
    return dict(records[TargetName])


def write(value, flags):
    assert flags == 0 and value['Type'] == 1 and value['Persist'] == 3
    records[value['TargetName']] = dict(value, CredentialBlob=value['CredentialBlob'].encode('utf-16le'))


def delete(Type, TargetName):
    assert Type == 1
    records.pop(TargetName, None)


win32cred = types.SimpleNamespace(CRED_TYPE_GENERIC=1, CRED_PERSIST_ENTERPRISE=3,
                                 CredRead=read, CredWrite=write, CredDelete=delete)
parent = types.ModuleType('win32ctypes')
module = types.ModuleType('win32ctypes.pywin32')
module.pywintypes, module.win32cred = types.SimpleNamespace(error=BackendError), win32cred
win32cred.__name__ = 'synthetic_win32cred'
sys.modules['win32ctypes'], sys.modules['win32ctypes.pywin32'] = parent, module
from keyring.backends.Windows import WinVaultKeyring
from confluence_mcp.auth import _save_record, ACCOUNT, _service

store = WinVaultKeyring()
service = _service(state['base'])
assert service == state['service']
assert json.loads(store.get_password(service, ACCOUNT)) == state['expected']
sys.platform = 'win32'
_save_record(store, service, json.dumps(state['updated'], ensure_ascii=False))
assert json.loads(store.get_password(service, ACCOUNT)) == state['updated']
blob = records[service]['CredentialBlob']
store.delete_password(service, ACCOUNT)
assert store.get_password(service, ACCOUNT) is None
print(json.dumps({'record': base64.b64encode(blob).decode('ascii'),
                  'deleted': all(v['UserName'] != ACCOUNT for v in records.values())}))
