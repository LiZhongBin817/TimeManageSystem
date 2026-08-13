# WSL 生产服务一键启动（含 Windows 8888 入口恢复）功能说明

## 一、功能概述

本功能提供 WSL 生产环境的**一键启动脚本**，实现以下能力：

1. 启动/校验 WSL 内的 Nginx 服务；
2. 启动/校验 WSL 内由 PM2 托管的 API 服务（`task-manage-api`，端口 `4000`）；
3. 启动 Windows 侧 Nginx，恢复固定访问入口 `http://localhost:8888`；
4. 逐层健康检查：WSL API `4000/health` → Windows 入口 `8888/health`；
5. 记录启动日志，便于排查问题。

## 二、背景与问题根因

项目生产环境分为两层服务：

- **WSL 内**：Nginx 监听 `18088`，API 服务监听 `4000`；
- **Windows 侧**：Nginx 监听 `8888`，将请求转发到 WSL 的 `18088`。

电脑重启后，Windows 侧 Nginx 没有随登录自动启动，导致 `8888` 入口不可用（只有 WSL 内 `18088` 可访问），用户访问旧书签地址失败。

修复方式：把 Windows Nginx 启动纳入 WSL 登录启动链，并做双重健康检查，避免“服务在线但端口不可访问”的情况再次出现。

## 三、涉及文件

| 文件 | 作用 |
| --- | --- |
| `scripts/start-wsl-production-services.ps1` | 一键启动脚本（入口） |
| `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\TimeManageSystem-WSL-ProductionStartup.cmd` | Windows 登录自启项，调用上述脚本 |
| `D:\学习项目\nginx-1.30.2\nginx-1.30.2\conf\nginx.conf` | Windows Nginx 配置：监听 `8888`，转发到 `127.0.0.1:18088` |
| `startup-logs/wsl-production-startup.log` | 启动日志 |

## 四、启动流程

```text
登录 Windows
  -> 启动项 .cmd（EncodedCommand 调用 PowerShell 脚本）
     -> 校验/启动 WSL Nginx（18088）
     -> 校验/启动 WSL PM2 API（4000）
     -> WSL 内 curl 4000/health 健康检查
     -> 启动 Windows Nginx（8888）
     -> Invoke-RestMethod 8888/health 健康检查
     -> 写启动日志
```

任一环节失败即中止并记录 `Startup failed`，避免启动“假成功”。

## 五、使用方式

### 手动启动

在 Windows PowerShell 中执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\学习项目\TimeManageSystem\scripts\start-wsl-production-services.ps1"
```

### 开机自启

保持启动目录中的 `TimeManageSystem-WSL-ProductionStartup.cmd` 存在即可，无需手动操作。

## 六、验证方式

启动完成后依次验证：

1. `http://localhost:8888` —— 返回前端页面；
2. `http://localhost:8888/health` —— 返回 `{"ok":true}`；
3. `http://172.30.0.50:8888` —— 局域网地址可访问（以当前 Windows 网卡实际 IP 为准）；
4. WSL 内 `curl http://127.0.0.1:4000/health` —— API 健康；
5. `startup-logs/wsl-production-startup.log` —— 查看两层健康检查记录。

## 七、注意事项与潜在坑点

1. **WSL IP 会变化**：WSL 重启后 IP 可能改变，因此统一走 Windows Nginx 的 `8888` 入口，不要把 WSL 内部 IP 写进收藏夹。
2. **中文路径编码**：启动目录的 `.cmd` 若直接写中文路径，可能因本地代码页导致路径损坏；当前方案使用 PowerShell `EncodedCommand`（UTF-8 Base64）传参解决。
3. **权限与依赖**：
   - Windows Nginx 启动依赖 `D:\学习项目\nginx-1.30.2\nginx-1.30.2\nginx.exe` 存在；
   - WSL 内依赖 Nginx、PM2 及 `task-manage-api` 已安装/注册；
   - WSL 发行版名为 `Ubuntu`，用户名为 `lizb`，如环境变化需同步修改脚本头部常量。
4. **防火墙**：Windows 防火墙需放行 `8888` 端口（入站），否则局域网其他机器无法访问。
5. **日志排查**：启动失败时优先查看 `startup-logs/wsl-production-startup.log`，最后一行会写明失败原因。

## 八、常用配置速查

```text
Windows Nginx 入口      : 0.0.0.0:8888
Windows Nginx 转发目标  : http://127.0.0.1:18088（WSL Nginx）
WSL Nginx              : 18088
WSL API                : 4000（PM2 进程名 task-manage-api）
WSL 发行版 / 用户       : Ubuntu / lizb
```
