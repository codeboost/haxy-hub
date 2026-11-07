import { bundledLanguages, type BundledLanguage } from "shiki/langs"

const languageByName: Readonly<Record<string, BundledLanguage>> = {
  "makefile": "make",
  "gnumakefile": "make",
  "dockerfile": "docker",
  "containerfile": "docker",
  "cmakelists.txt": "cmake",
  "gemfile": "ruby",
  "rakefile": "ruby",
  "podfile": "ruby",
  "vagrantfile": "ruby",
  "brewfile": "ruby",
  "jenkinsfile": "groovy",
  "justfile": "just",
  "codeowners": "codeowners",
  "cargo.lock": "toml",
  "nginx.conf": "nginx",
  ".bashrc": "shellscript",
  ".bash_profile": "shellscript",
  ".zshrc": "shellscript",
  ".profile": "shellscript",
  ".env": "dotenv",
  ".gitconfig": "ini",
  ".editorconfig": "ini",
}

const languageByPrefix: ReadonlyArray<readonly [string, BundledLanguage]> = [
  ["dockerfile.", "docker"],
  [".env.", "dotenv"],
]

const languageByExtension: Readonly<Record<string, BundledLanguage>> = {
  h: "c",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  cc: "cpp",
  cxx: "cpp",
  ino: "cpp",
  m: "objective-c",
  mm: "objective-cpp",
  ex: "elixir",
  exs: "elixir",
  hrl: "erlang",
  ml: "ocaml",
  mli: "ocaml",
  pl: "perl",
  pm: "perl",
  htm: "html",
  xhtml: "html",
  svg: "xml",
  xsd: "xml",
  plist: "xml",
  csproj: "xml",
  zon: "zig",
  s: "asm",
  patch: "diff",
  gradle: "groovy",
  env: "dotenv",
  sv: "system-verilog",
  svh: "system-verilog",
}

function isBundled(id: string): id is BundledLanguage {
  return Object.hasOwn(bundledLanguages, id)
}

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1) : null
}

function languageForExtension(extension: string): BundledLanguage | null {
  if (Object.hasOwn(languageByExtension, extension)) return languageByExtension[extension]
  return isBundled(extension) ? extension : null
}

/** The grammar a file's name suggests, or null for plain text. */
export function languageForFile(name: string): BundledLanguage | null {
  const lower = name.toLowerCase()
  if (Object.hasOwn(languageByName, lower)) return languageByName[lower]
  const prefixed = languageByPrefix.find(([prefix]) => lower.startsWith(prefix))
  if (prefixed) return prefixed[1]
  const extension = extensionOf(lower)
  return extension === null ? null : languageForExtension(extension)
}
