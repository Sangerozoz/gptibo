export async function prepareProductImage(file: File) {
  if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('请选择 5 MB 以内的 PNG 或 JPG 图片。')
  const source = await createImageBitmap(file)
  try {
    if (!source.width || !source.height || source.width > 8192 || source.height > 8192) throw new Error('图片尺寸过大。')
    for (const longest of [720, 600, 480, 360, 256]) {
      const scale = Math.min(1, longest / Math.max(source.width, source.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(source.width * scale))
      canvas.height = Math.max(1, Math.round(source.height * scale))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('当前浏览器无法处理图片。')
      context.drawImage(source, 0, 0, canvas.width, canvas.height)
      const data = canvas.toDataURL('image/png')
      if (data.length <= 460000) return data
    }
    throw new Error('图片处理后仍然过大，请选择更简单的图片。')
  } finally { source.close() }
}
