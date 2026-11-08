# dsh-msp-filewatch

把「目录里出现的新文件」变成 MSP 信号。**只监控目录的直接子项，不递归。**

## 它是什么

一个 dsh 插件，**同时**是一个 MSP 节点：

- 作为插件：由 `cordis.patch.yml` 挂进宿主，随 dsh 启动
- 作为节点：自己起 `MSPNode`，publish `file.created`，不需要别人知道它在哪

## 安装

```powershell
cd <这个目录>
pnpm install            # 装 msp-ts（file:../../vendor/msp-ts）
dsh plugin --profile superagent add link:$PWD
```

然后在 profile 的 `cordis.patch.yml` 里配置（参考本目录那份）并重启 dsh。

## 配置

```yaml
- id: msp-filewatch
  name: dsh-msp-filewatch
  config:
    dirs: [C:/Users/asus/Downloads]   # 要监控的目录，只取直接子项
    nodeName: filewatch               # MSP 节点名，信号里会带上它
    settleMs: 1500                    # 文件大小稳定这么久才发
    extensions: []                    # 留空=全部；写 ["pdf","docx"] 则只发这些
```

## 信号长什么样

```json
{ "name": "Report.pdf", "path": "C:/Users/asus/Downloads/Report.pdf", "bytes": 18231 }
```

路径 `file.created`。

## 三条设计约束

1. **不递归** —— 只 `readdirSync(dir)` 和 `watch(dir, {recursive:false})`，子目录一律跳过
2. **一文件一信号** —— 大小稳定才发；发过标记 `-1`，排队标记 `-2`，不会重复
3. **既有文件不补发** —— 启动时把目录里已有的文件标记为已处理
