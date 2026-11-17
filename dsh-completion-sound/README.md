# 完成提示音（Completion sound）

版本：1.1.1。适配 DS Bot 0.3.5：整段工作结束后提醒，区分正常完成、异常断开与手动中断。DS Bot 原包及 DSH 安装目录保持原样。

1.1.1 修复：Host 生命周期路由补齐开头的 `/`，修正 1.1.0 接口注册失败导致所有任务静音的问题。新增真实 DSH 路由校验（含旧路径负对照）、真实 HTTP 轮询三类通知验收，以及构建后客户端从状态检测到 Web Audio 启动的回归测试。当前自动化回归 57/57 通过；当前宿主两个接口均已实际调用返回 200。

## 提醒规则

| 场景 | 行为 |
| --- | --- |
| 中途回复、工具调用与步骤结束 | 保持静音，不按消息条数触发 |
| 仍在运行、等待委派结果、切换聊天分段 | 保持静音，继续跟踪同一段工作 |
| 等待审批、问题卡或待提交视图 | 保持静音，不当成完成或故障 |
| 工作完成 | 收到真实 `turn/end` completed，且 DS Bot 与 Session 均空闲，无待返回工作；至少两次采样、稳定 1.8 秒后响一次 |
| 模型／运行异常 | 错误最终结束后播放异常音；短暂错误后立即重试继续运行时不响 |
| 工作期间连接持续断开 | 自首次失败采样起持续至少 8 秒后提示一次；请求超时与轮询间隔会增加实际检测延迟；空闲时断开不响 |
| 工作消失却没有终止事件 | 持续空闲 15 秒仍缺终止证据时归入异常，再经稳定确认；不推测成功 |
| 手动停止 | 识别 user 取消和 `ds-bot/stopped`，使用中断音 |
| 插话、内部 hook、分段切换 | 不当成手动中断 |
| 多个 Bot 同时结束 | 分别排队提醒，不再被全局冷却吞掉；间隔 1.8 秒 |
| 子代理完成 | 子代理本身不响，由上层工作最终结束决定 |
| 群组工作 | 汇总成员工作，群组整体空闲后提醒，隐藏成员 Session 不重复响 |

“彻底结束”指运行生命周期已收束，不按文本里的“完成了”判断，也不声称自动理解任务的语义完成度。浏览器页面关闭时没有前端音频；工作期间应保持 DSH 页面开启。

## 设置

位置：「设置 → 完成提示音」。

| 项目 | 说明 |
| --- | --- |
| 启用 | 总开关，默认开启 |
| 工作完成提示音 | 沿用原来的声音选择和自定义音频 |
| 异常断开提示音 | 默认“双响提醒”，可独立选择 26 个内置音效或静音 |
| 手动中断提示音 | 默认“8-bit 下行”，可独立选择 26 个内置音效或静音 |
| 音量 | 三类提示共用，0–100 |
| 提醒范围 | 所有对话／仅当前打开的对话 |
| 自定义音频 | 完成音支持 URL 或本地文件（≤2 MB） |

原来的浏览器存储键 `dsh.completion-sound.v1` 保持不变；已有完成音、音量、自定义音频和范围保留，新字段按默认值补齐。浏览器首次点击或按键解锁音频。内置声音由 Web Audio 现场合成，不下载音频资源。

## 项目结构与实现

```text
index.js                  Host 只读生命周期观察与 API 注册
lib/lifecycle.js          终止原因分类、DS Bot 状态归一、去重状态机
lib/journal.js            有界内存事件游标，不存消息正文
lib/monitor.js            读取生命周期 API 与 DS Bot 公开状态 API
src/client.js             可维护的界面、音效与监听器源码
scripts/build.mjs         将纯状态机及监听器嵌入浏览器模块
client.js                 构建产物，供 DSH 加载
cordis.patch.yml          独立插件注册
locale/                   插件元数据翻译
icon.svg                  导航图标
test/                     生命周期、Host API、轮询及客户端回归
```

每秒读取一次自有 `api/completion-sound/lifecycle`，随后读取 DS Bot 现有 `api/bot` 的 `state`。结合 `work.bots/rooms/turns/waiting/approvals`、问题卡及 Session 运行状态，按 Bot 跨分段聚合。没有安装 DS Bot 时，使用真实终止事件加普通 Session 状态。

Host 只记录 Session ID、回合号、游标和结束类别，保存在最多 1024 条的内存环形队列；不读取或改写会话日志、Bot 文件、配置或提示词。游标初次连接不重播旧提示；页面重连不把断开误判为完成。

## 构建与测试

```powershell
node scripts/build.mjs
node scripts/build.mjs --check
node --test 'test/*.test.js'
node scripts/host-smoke.mjs 'DSH_CHECKOUT'
```

## 安装与生效

项目位置：`F:\Agent\Deepseek-plugin\dsh-completion-sound`。

```text
plugin_manager install_bundle
  target: link:F:/Agent/Deepseek-plugin/dsh-completion-sound
  enabled: true
```

更新源码后先构建，再重新加载本插件并刷新 DSH 页面。仅在同一 checkout 的 `pnpm run dev:web` 构建监听运行时，才预期客户端自动热更新。运行状态与浏览器实际发声需分别验收。

## 手动验收

1. 启动一个含多次工具调用和进度消息的 Bot 任务：中途静音，最后只响一次完成音。
2. 委派给其他 Bot 并等待：等待期静音，返回并汇总结束后提醒。
3. 使用界面的停止按钮：响中断音，不再响同轮完成音。
4. 隔离测试中令模型请求最终报错：响异常音；自动重试继续工作时不提前响。
5. 隔离测试页面连接在工作中持续断开：经过检测期响异常音一次；短暂断开或空闲断开不响。
6. 设置三种声音并逐个试听，确认音色可分辨；原完成音与音量仍在。

卸载使用 `plugin_manager remove_bundle`，target 为 `@local/dsh-completion-sound`。
