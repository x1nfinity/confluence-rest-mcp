# Windows 凭据实机验收

验收入口为 `typescript/scripts/windows-acceptance.mjs`，npm 入口为 `npm run check:windows`。本说明面向源码目录；脚本没有放入 npm 运行包。它验证 Credential Manager 与 Python／TS 的凭据存储链路，不连接 Confluence，也不调整客户端。

每次运行自动生成 UUID，站点固定为 `https://windows-credential-check.example.invalid/<UUID>/<case>`，生成 8 组独立 service 和合成账号／密码。脚本不接受业务站点参数。首次预检要求两个目标都为空；有记录时停止且不清理未领取的目标。清理只接受该运行的合成内容与 account，其他记录保留并报错。原 Python、.venv、.local 和个人凭据不迁移、不导出，不运行安装器。

## 1. 准备和直接运行

使用 Windows 桌面登录用户的普通终端。准备 Node 22.23.2／npm 10.9.8、系统 Windows PowerShell 5.1，以及 Windows Python 3.9+ 环境，要求 keyring==25.6.0 和可用的 WinVault 后端。互读对照需要验收人员另备与冻结基线一致的 Python 0.14.0 实现，置于源码根目录的 `native/`；公开源码和 npm 包提供 TypeScript 实现，生产运行不依赖该 Python 对照。Windows x64、ARM64 分别运行并保存结果；不用管理员身份绕过企业策略。

在 PowerShell 中执行，目录可包含中文或空格：

```powershell
# 从源码仓库根目录进入
Set-Location '.\typescript'
node --version
npm --version
npm ci --ignore-scripts
npm run build
$python = (Resolve-Path '..\native\.venv\Scripts\python.exe').Path
$report = Join-Path $env:TEMP ('confluence-windows-' + [guid]::NewGuid().ToString('N') + '.json')
npm run check:windows -- --python "$python" --report "$report"
$LASTEXITCODE
Get-Content -LiteralPath $report
```

如果正式 Python 安装在其他位置，将 `$python` 指向其真实 python.exe。不能直接使用从 macOS 复制过来的 .venv。脚本从自身路径找到仓库源文件，与运行时当前目录无关；也可从 TypeScript 目录执行 `node .\scripts\windows-acceptance.mjs --python "$python" --report "$report"`。

若没有可用的测试 Python 环境，可由验收人员另建临时环境，不覆盖现有 .venv：

```powershell
$testEnv = Join-Path $env:TEMP ('confluence-python-' + [guid]::NewGuid().ToString('N'))
py -3 -m venv "$testEnv"
$python = Join-Path $testEnv 'Scripts\python.exe'
& $python -m pip install 'keyring==25.6.0'
```

脚本检查 keyring 版本、真实 WinVault 后端和本机 Python 对照的冻结文件指纹；不自动安装依赖、保存配置或修复系统权限。企业环境不允许 PowerShell／Add-Type 时，记录失败并交由环境负责人核对，不停用保护或修改执行策略。

## 2. 自动执行的 8 组验收

- **interop**：原 Python `_save_record` 保存合成记录，TS 实读；TS 保存另一条完整记录，原 Python `get_credentials` 实读；再由 Python 换密及删除。覆盖 UTF-16LE、Unicode／转义、service／account 和整对身份。
- **failure**：真实旧记录存在时，拒绝候选身份、TS 超长记录拒绝后检查旧值；Python 尝试超过 WinCred 大小上限的保存，核对旧值保留。另在生产 C# 生命周期的 API 边界注入保存失败，必须确认命中注入点且旧值不变。身份验证器为合成拒绝回调，不是实际登录。
- **collision**：合成其他 account 占用主目标，自有记录放入 account@service；验证 TS 读取与换密、其他 account 完整保留、注销只删自有记录。
- **conflict**：两个目标都属于合成其他 account 时，保存拒绝、注销不删除，逐项检查记录保持原样。
- **delete**：主记录与旧碰撞记录并存，在清碰撞项／清主项的位置分别注入失败；核对第一项失败未清主项、第二项失败允许已清旧碰撞项但主项仍在。然后正常删除、复查为空并重复注销。
- **races**：在真实隔离存储上，确定性插入保存期间同 account 换密、删除碰撞项后主目标归属变化、删除主项后出现新碰撞项；检查生产代码报错、保留新值、不追删或误报成功。
- **concurrent**：两个独立 Node 进程对同一随机站点执行写／读／删，检查完整身份对不会混合或返回未知值。等待所有工作进程结束后才清理；单次桥接操作受生产实现期限约束，不提前杀工作进程而留下凭据子进程。
- **lock**：真实 Global 锁与实际 SID；在生产 C# 编译完成、进入 Run 前发出就绪信号，验证持锁期间操作阻塞，释放后继续；再终止隔离持锁进程，验证遗弃锁恢复。本项仅覆盖同登录会话。

`real_store_and_controlled_fault`／`real_store_and_controlled_race` 表示调用真实 WinCred 处理合成记录，同时在测试副本的 API 边界注入特定失败／改写；它们不能代替真实权限故障。`scripts/windows-acceptance-hooks.mjs` 仅改包裹调用，生产 Run 的保存、快照复核和删除顺序保持原样，原文件不改写。

Python 超限保存只有在返回明确 CredWrite 的 Windows 错误时，才记为真实 API 失败；如果 Python 绑定提前拒绝，报告保留 `native_api_failure_not_confirmed`。不修改整个 Credential Manager 的权限来制造失败。真实中断／权限失败以及相同时间戳、长度的故障边界，以既有离线测试与实机证据分别说明。

## 3. 同一用户跨登录会话的 Global 锁

这一项需要同一电脑、同一 Windows 用户的两个实际登录会话，例如本地桌面和 RDP；同一桌面的两个终端不能替代。不要更改用户、服务或凭据库权限来创建场景。

在会话 A 生成新的 UUID 并持锁：

```powershell
$runId = [guid]::NewGuid().ToString()
$runId
node .\scripts\windows-acceptance.mjs --hold-lock $runId
```

出现 `event=locked` 后，20 秒自动释放。立刻在会话 B 填入相同 UUID，执行只读探测：

```powershell
$runId = '填入会话A的UUID'
node .\scripts\windows-acceptance.mjs --probe-lock $runId
```

探测从生产桥接代码编译完成后计时，`elapsed_ms` 应随持锁剩余时间而增长；释放后再运行一次作为无持锁对照。分别保存两会话的命令结果、Windows 架构、是否跨会话，不保存 SID、用户名或凭据。探测输出 `requires_two_session_comparison`，不会自行把计时判为通过。

另有合法的不同 Windows 用户会话时，可复用上述 UUID 探测：不同用户应不被会话 A 的锁阻塞。没有该环境则保持 `different_windows_users_acl` 待验收，不创建账号或提权代替。实机还需核对企业策略，以及不同权限等级的同用户访问；脚本不调整 ACL。

## 4. 结果、异常与清理

开始时输出运行 ID，每组输出固定名称、层级和状态；JSON 报告只写版本、架构、计数、状态和待验收项，不含凭据、记录正文、Windows 身份或底层异常。报告路径必须是新文件，不覆盖已有文件。

- `passed_with_pending`：自动矩阵及清理通过，跨会话、不同用户 ACL、企业策略、本人交互登录与宿主重载仍待核对。
- `failed`：用例或清理失败，退出码 1；不能按已完成验收处理。
- `cleanup[].status=not_claimed`：预检未领取的范围，没有执行删除。
- `SCOPE_OCCUPIED`：隔离目标有不符合本次合成标记的记录，脚本保留该记录；不能放宽标记或删除整个命名空间。

普通失败会执行 finally 清理并确认两个目标消失；强制结束主脚本、关闭终端或断电可能来不及清理。发生中断时，先等原工作进程结束／终止其所属的隔离测试进程树，再使用开始时打印的 UUID，在相同 Windows 用户下执行定向清理：

```powershell
node .\scripts\windows-acceptance.mjs --cleanup '本次运行的UUID' --python "$python"
```

清理不枚举凭据库，只处理固定 8 组目标，检查 account 与已知合成内容后删除并复查。若报告已有 `failed` 清理项，也使用同一命令重试；标记不符仍会拒绝，保留记录供人工核对。不要把真实账号／密码放入脚本、参数、报告或回复。

## 5. 验收状态与剩余门槛

当前尚未在 Windows 实机运行，本文提供验收方法，不作为实机通过证明。自动化的合成、范围、标记、故障注入及非 Windows 拒绝检查与实机验收分别报告；`passed_with_pending` 不表示全部门槛完成。

本人隐藏输入、真实站点身份验证／换密、Codex／Cursor 重载、真实 ACL 拒绝与跨登录会话需要独立实机证据。WinCred 不提供条件写／删除，Python／旧版 TS／系统 UI 不参与新锁，最终复核和 API 调用之间的外部竞态仍存在；两目标删除也不是事务。

只读有限试用和最终发行状态见 [发行说明](RELEASE.md)。公开报告只保留平台、版本、架构、用例状态及待验收项。
