/** 浏览器文件到 bridge 载荷的共享转换：预设文本与技能二进制共用同一入口。 */
export interface ImportFileEntry {
  path: string
  content: string
}

function readFile(file: File, encoding: 'text' | 'base64'): Promise<string> {
  if (encoding === 'text') return file.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error(`读取文件失败：${file.name}`))
        return
      }
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : '')
    }
    reader.onerror = () => reject(reader.error ?? new Error(`读取文件失败：${file.name}`))
    reader.readAsDataURL(file)
  })
}

export async function readImportFiles(
  files: readonly File[],
  encoding: 'text' | 'base64',
): Promise<ImportFileEntry[]> {
  return Promise.all(files.map(async (file) => ({
    path: file.webkitRelativePath || file.name,
    content: await readFile(file, encoding),
  })))
}
