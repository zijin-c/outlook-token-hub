# Outlook Hub · 免登录令牌取件 & 45天自动保活中心

专为 `email----password----client_id----refresh_token` 格式的 Outlook / Hotmail 令牌号设计的自托管 Web 邮件面板，集成了**免登录直接取件**、**按导入时间 45 天自动刷新覆盖**、**项目分组标注**以及**账号密码登录与多设备云端同步**。

## 核心特性

- **免登录直接取件（多协议自动路由）**
  - 自动按令牌权限路由：优先 **Outlook REST API v2.0** → **Microsoft Graph API v1.0** → 自动回退 **IMAP XOAUTH2**
  - 支持收件箱、垃圾箱、全部邮件查看，自动识别 **4~8 位验证码（OTP）** 并支持一键复制
- **按导入时间独立计时，每 45 天自动刷新并覆盖**
  - 每个邮箱记录独立的导入时间（`importedAt`）、上次刷新时间与下次自动刷新时间（默认 **+45 天**，可在页面调整 1~89 天）
  - 到期后后台自动向微软换取新凭证，并将微软轮换返回的新 `refresh_token` **自动覆盖保存**，避免 90 天不活跃失效
  - 随时一键复制或下载覆盖后的最新 `email----password----client_id----refresh_token` 凭证（支持按项目分组导出）
- **项目分组与备注分类**
  - 支持自定义项目分组（如 `Claude`、`OpenAI`、`Cursor`、`AWS`）与 8 种颜色标识，导入时即可批量归组
  - 支持单号备注标注、搜索过滤及按分组导出
- **服务端持久保存 & 多设备同步登录**
  - 内置独立账号密码登录与 30 天持久化签名 Cookie（`scrypt` 加盐哈希存储，服务重启不掉登录）
  - 首次打开网页自助初始化管理员账号密码（也支持通过环境变量 `ADMIN_USER` / `ADMIN_PASSWORD` 预设）
  - 所有账号、分组、备注与最新凭证持久保存在服务端 `data/db.json`，电脑/手机等多设备登录同一账号即可实时同步
- **极简三栏现代 UI**
  - 支持浅色/深色主题一键切换，宽屏邮件列表 + 点开进入详情阅读视图

## 快速部署

### 方式一：Linux 服务器一键部署（无需 Docker，自动安装环境 + 开机自启）

在 Debian / Ubuntu / CentOS 服务器上直接执行这一条命令即可（重复执行可无损更新）：

```bash
curl -fsSL https://raw.githubusercontent.com/zijin-c/outlook-token-hub/main/install.sh | bash
```

部署完成后直接访问 `http://你的服务器IP:18742`，首次打开网页设置管理员账号密码即可。

### 方式二：Docker Compose 部署

```bash
git clone https://github.com/zijin-c/outlook-token-hub.git
cd outlook-token-hub
docker compose up -d --build
```

启动后访问 `http://你的服务器IP:18742`，首次打开网页即可设置管理员账号密码。

如需通过环境变量预设管理员账号密码，可编辑 `docker-compose.yml`：

```yaml
environment:
  - PORT=18742
  - TZ=Asia/Shanghai
  - ADMIN_USER=admin
  - ADMIN_PASSWORD=你的强密码
```

所有数据均持久化挂载在宿主机的 `./data/db.json`，重建容器或升级镜像不会丢失任何邮箱与最新令牌。

### 方式三：本地 Node.js 运行（需要 Node.js 18+）

```bash
npm install
npm start
```

访问 `http://localhost:18742`。
