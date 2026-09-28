declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module 'virtual:prompt-tool-styles' {
  export function install(): () => void
}
