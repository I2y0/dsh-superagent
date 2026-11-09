// 一个只有三行的壳：实现住在 dsh-superagent 的 src/sources/nene-inbox.ts（有测试、有文档表），
// 宿主按**包名**加载插件（cordis.patch.yml 的 name），而 `dsh-superagent/nene-inbox-watch`
// 这种子路径在加载器那里解析不到 —— 所以给它一个自己的包名。
//
// 依赖靠同目录的 node_modules/dsh-superagent 软链（指向原型仓库）解析，不在安装期拉。
export { apply, inject, name } from 'dsh-superagent/nene-inbox-watch'
