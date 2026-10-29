# Pi Pocket Models

一个 Pi Pocket 扩展：把「谁用什么模型、什么思考档位」收归到一张表里，subagent/team 派发时按角色名注入 model + thinking，表外角色直接拒绝。

## 安装

```sh
cp pi-pocket-models.ts _dispatch.ts ~/.pi-pocket/extensions/
```

然后在 Pocket 扩展页启用，或在会话里让模型调用 `model_policy` 查看当前表。

## 工具

- `model_policy`：只读，列出角色表、白名单缺口、与 config.json / _dispatch.ts 的漂移
- `model_policy_set`：改一个角色的模型与档位，按模型目录校验支持的档位
