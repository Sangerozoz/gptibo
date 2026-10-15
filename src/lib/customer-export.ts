import type { CustomerExport } from '../../shared/customers.ts'

const time=(v:number|null)=>v===null?'':new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})
const kinds={open:'首次开通',renew:'续费',upgrade:'升级'}
export async function customerWorkbook(data:CustomerExport) {
  const {default:ExcelJS}=await import('exceljs')
  const workbook=new ExcelJS.Workbook();workbook.creator='硅基生物';workbook.created=new Date(data.asOf)
  const names=new Map(data.customers.map(c=>[c.id,c]))
  const customers=workbook.addWorksheet('客户资料')
  customers.addRow(['客户编号','客户名称','所属代理','客户来源','微信','QQ','邮箱','备注','录入时间（北京时间）'])
  data.customers.forEach(c=>customers.addRow([c.id,c.name,c.partner_name||'直营',c.source,c.wechat,c.qq,c.email,c.note,time(c.created_at)]))
  const accounts=workbook.addWorksheet('当前会员')
  accounts.addRow(['客户编号','客户名称','所属代理','账号','当前套餐','开通时间（北京时间）','到期时间（北京时间）','本期付款（元）','账号备注'])
  data.accounts.forEach(a=>{const c=names.get(a.customer_id);accounts.addRow([a.customer_id,c?.name,c?.partner_name||'直营',a.account,a.plan_name||'未录入',time(a.opened_at),time(a.expires_at),a.paid_cents===null?'':a.paid_cents/100,a.note])})
  const history=workbook.addWorksheet('开通续费升级记录')
  history.addRow(['记录编号','客户编号','客户名称','所属代理','账号','记录类型','历史套餐','开通时间（北京时间）','到期时间（北京时间）','实付金额（元）','记录备注','录入时间（北京时间）'])
  data.subscriptions.forEach(s=>{const c=names.get(s.customer_id);history.addRow([s.id,s.customer_id,c?.name,c?.partner_name||'直营',s.account,kinds[s.kind],s.plan_name,time(s.opened_at),time(s.expires_at),s.paid_cents/100,s.note,time(s.created_at)])})
  for(const sheet of workbook.worksheets) {
    sheet.views=[{state:'frozen',ySplit:1}];sheet.autoFilter={from:{row:1,column:1},to:{row:sheet.rowCount,column:sheet.columnCount}}
    sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF126BDE'}}
    sheet.getRow(1).height=26
    sheet.columns.forEach((column,i)=>{column.width=i===0?38:24;column.alignment={vertical:'top',wrapText:true}})
  }
  accounts.getColumn(8).numFmt='0.00';history.getColumn(10).numFmt='0.00'
  // All user data is stored as literal strings, never formulas.
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}
export async function downloadCustomers(data:CustomerExport) {
  const buffer=await customerWorkbook(data)
  const url=URL.createObjectURL(new Blob([buffer as BlobPart],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}))
  const link=document.createElement('a');link.href=url;link.download=`客户会员记录-${new Date(data.asOf+8*3600000).toISOString().slice(0,10)}.xlsx`;link.click()
  setTimeout(()=>URL.revokeObjectURL(url),1000)
}
