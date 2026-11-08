---
id: doc-archive
trigger: file.created
condition: file.extension in ["pdf", "docx"]
action: 只做三件事：1) 若文件名含「合同」「发票」或大于 10MB，开单询问，不动文件；2) 否则把文件移动到 ~/Documents/Work/，文件名不变；3) 用 report 交付一句结果。不读无关目录、不查系统数据库、不自己造弹窗通知——通知由通道负责。
trust_level: L1
---
# 工作文档归档
人找文件靠路径和日期，不靠原文件名。目录边界只有 Downloads 和 Documents/Work。
