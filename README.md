# 📊 三金基金助手

对接真实市场数据的多基金投资组合看板，支持 ETF 和普通基金实时盈亏监控。

## 数据源

| 类型 | 数据源 | 示例 |
|------|--------|------|
| ETF（15/16/51/56开头） | 新浪股票实时行情 | 159625 绿色电力 |
| 普通基金 | 天天基金实时估值 | 110011 易方达优质精选 |

## 部署到 Zeabur

[![Deploy on Zeabur](https://zeabur.com/button.svg)](https://zeabur.com/templates/0X4SD7)

1. 点击上方按钮，或手动创建项目
2. 选择 **GitHub** 导入本仓库
3. 服务类型选 **「服务」**（非静态网站）
4. 自动部署，无需任何配置
5. 部署完成后点 **「生成域名」** 获取公网地址

## 本地开发

```bash
npm install
npm start
# 打开 http://localhost:3000
# 带演示数据: http://localhost:3000/?demo=1
```
