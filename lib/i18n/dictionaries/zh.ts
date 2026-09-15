import type { TranslationDictionary } from "@/lib/i18n/config"

const messages = {
  "common.language": "语言",
  "common.close": "关闭",
  "common.reload": "重新加载页面",
  "common.clear": "清除",
  "home.today": "今天：",
  "home.scanQr": "扫描二维码付款",
  "home.paymentReceived": "已收到付款！",
  "home.waitingPayment": "等待付款...",
  "home.sharePayment": "分享付款",
  "home.copyLink": "复制链接",
  "home.paymentId": "付款 ID",
  "home.nextCustomer": "下一位客户",
  "home.amount": "金额",
  "home.generateQr": "生成二维码",
  "home.convertLocal": "将本地价格转换为 Pi",
  "convert.title": "转换为 Pi",
  "convert.localAmount": "本地金额",
  "convert.enterAmount": "输入金额",
  "convert.currency": "货币",
  "convert.piRate": "Pi 参考汇率",
  "convert.rate": "汇率",
  "convert.piAmount": "Pi 金额",
  "convert.useAmount": "使用此 Pi 金额",
} satisfies TranslationDictionary

export default messages
