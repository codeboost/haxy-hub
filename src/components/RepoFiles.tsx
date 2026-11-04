import { useEffect } from "react"
import { Link, useLocation, useSearchParams } from "react-router"
import { File, Folder, CornerLeftUp } from "lucide-react"
import { EmptyState, FailureState, LoadingState, Pager } from "@/components/listing"
import { Markdown } from "@/components/Markdown"
import type { LinkTarget } from "@/lib/markdown"
import { displaySegment, getFiles, parentPath, pathSegments, repoLinkPath, repoRoute, type DirListing, type EncodedPath, type FileView, type RepoLocator } from "@/lib/repo"
import { useResource } from "@/lib/resource"

// A repository's files at the default branch. The URL holds everything a
// view shows: the path (encoded exactly as Haxy encodes it), a directory
// page's `cursor`, a file window's first `line`, and the selected line as
// `#L<n>`, so refresh and shared links reconstruct it.

function repoKey(repo: RepoLocator): string {
  return repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
}

/** The window start the URL asks for: a positive `line`, else the first line. */
function windowStart(params: URLSearchParams): number {
  const value = Number(params.get("line"))
  return Number.isSafeInteger(value) && value > 1 ? value : 1
}

/** The line `#L<n>` selects, or null. */
function selectedLine(hash: string): number | null {
  const match = /^#L([1-9][0-9]*)$/.exec(hash)
  return match ? Number(match[1]) : null
}

const linkClass = "text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"

/** Links in a repository file's Markdown: repository paths open in the files view. */
function markdownLinks(repo: RepoLocator, dir: EncodedPath): (destination: string) => LinkTarget {
  return (destination) => {
    const target = repoLinkPath(destination, dir)
    switch (target.kind) {
      case "external": return target
      case "repo": return { kind: "internal", to: repoRoute(repo, target.path) }
      case "none": return target
    }
  }
}

/** The repository name, then each directory of `path`, each leading back up. */
function PathCrumbs({ repo, name, path }: { repo: RepoLocator; name: string; path: EncodedPath }) {
  const segments = pathSegments(path)
  return (
    <nav aria-label="Path" className="mt-8 flex flex-wrap items-center gap-1 font-mono text-sm">
      {segments.length === 0 ? <span aria-current="page" className="font-semibold">{name}</span> : <Link to={repoRoute(repo)} className={linkClass}>{name}</Link>}
      {segments.map((segment, index) => {
        const last = index === segments.length - 1
        return (
          <span key={index} className="flex items-center gap-1">
            <span aria-hidden className="text-muted-foreground">/</span>
            {last ? <span aria-current="page" className="font-semibold">{displaySegment(segment)}</span> : <Link to={repoRoute(repo, segments.slice(0, index + 1).join("/"))} className={linkClass}>{displaySegment(segment)}</Link>}
          </span>
        )
      })}
    </nav>
  )
}

function Directory({ repo, listing, cursor }: { repo: RepoLocator; listing: DirListing; cursor: string }) {
  const rowClass = "flex items-center gap-2 px-4 py-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
  return (
    <>
      {listing.items.length === 0 && !cursor ? (
        <EmptyState title="This directory is empty" />
      ) : (
        <ul aria-label="Files" className="mt-4 divide-y rounded-xl border bg-card">
          {listing.path && (
            <li><Link to={repoRoute(repo, parentPath(listing.path))} aria-label="Parent directory" className={rowClass}><CornerLeftUp size={16} aria-hidden className="text-muted-foreground" />..</Link></li>
          )}
          {listing.items.map((item) => (
            <li key={item.path}>
              <Link to={repoRoute(repo, item.path)} className={rowClass}>
                {item.kind === "dir" ? <Folder size={16} aria-hidden className="text-primary" /> : <File size={16} aria-hidden className="text-muted-foreground" />}
                <span className="font-mono">{item.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Pager page={listing.page} search="" cursor={cursor} noun="Files" base={repoRoute(repo, listing.path)} />
      {listing.readme && <Readme key={listing.readme.path} repo={repo} path={listing.readme.path} name={listing.readme.name} />}
    </>
  )
}

/** A directory's README, shown beneath its listing as the TUI shows it when the directory opens. */
function Readme({ repo, path, name }: { repo: RepoLocator; path: EncodedPath; name: string }) {
  const file = useResource(`readme ${repoKey(repo)} ${path}`, (signal) => getFiles(repo, { path }, { signal }))
  const headingId = "readme-heading"
  return (
    <section aria-labelledby={headingId} className="mt-8 rounded-xl border bg-card">
      <h2 id={headingId} className="border-b px-4 py-2 font-mono text-sm font-semibold">{name}</h2>
      <div className="p-4 sm:p-6">
        {file.kind === "loading" && <LoadingState>Loading {name}…</LoadingState>}
        {file.kind === "failed" && <FailureState title={`Couldn't load ${name}`} error={file.error} onRetry={file.reload} />}
        {file.kind === "loaded" && file.data.kind === "file" && <FileBody repo={repo} file={file.data} />}
      </div>
    </section>
  )
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US")
}

/** A file's content in whichever state it is: rendered Markdown, numbered lines, empty or binary. */
function FileBody({ repo, file }: { repo: RepoLocator; file: FileView }) {
  const { hash } = useLocation()
  const target = selectedLine(hash)
  const content = file.content
  // Window links and permalinks name the file itself, also where it shows
  // inside its directory (a README).
  const fileRoute = repoRoute(repo, file.path)

  useEffect(() => {
    if (target === null) return
    document.getElementById(`L${target}`)?.scrollIntoView({ block: "center" })
  }, [target, file])

  if (content.kind === "empty") return <EmptyState title="This file is empty">It has no content at all.</EmptyState>
  if (content.kind === "binary") return <EmptyState title="Binary file not shown">Haxy only shows text files.</EmptyState>
  if (file.markdown) return <Markdown blocks={file.markdown} resolveLink={markdownLinks(repo, parentPath(file.path))} />

  const end = content.start_line + content.lines.length - 1
  const windowQuery = content.start_line > 1 ? `?line=${content.start_line}` : ""
  const partial = content.start_line > 1 || content.has_more
  const outside = target !== null && (target < content.start_line || target > end)
  return (
    <>
      {partial && (
        <p role="status" aria-label="Partial content" className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-2 text-sm">
          <span>Showing lines {formatNumber(content.start_line)}–{formatNumber(end)} of {formatNumber(content.total_lines)}.</span>
          {content.start_line > 1 && <Link to={fileRoute} className={linkClass}>First lines</Link>}
          {content.next_line !== null && <Link to={`${fileRoute}?line=${content.next_line}`} className={linkClass}>Next lines</Link>}
        </p>
      )}
      {outside && (
        <p className="mb-4 text-sm text-muted-foreground">
          Line {formatNumber(target)} isn't in this window. <Link to={`${fileRoute}?line=${target}#L${target}`} className={linkClass}>Show line {target}</Link>
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border">
        <table aria-label={file.name} className="w-full border-collapse font-mono text-xs leading-5">
          <tbody>
            {content.lines.map((line, index) => {
              const number = content.start_line + index
              const current = number === target
              return (
                <tr key={number} id={`L${number}`} aria-current={current ? "location" : undefined} className={current ? "bg-amber-500/15" : undefined}>
                  <td className="w-px border-r px-3 text-right align-top text-muted-foreground select-none">
                    <Link to={`${fileRoute}${windowQuery}#L${number}`} aria-label={`Line ${number}`} preventScrollReset className="hover:text-foreground hover:underline">{number}</Link>
                  </td>
                  <td className="px-3 whitespace-pre">{line}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

function FileSection({ repo, file }: { repo: RepoLocator; file: FileView }) {
  return (
    <section aria-labelledby="file-heading" className="mt-4">
      <h2 id="file-heading" className="mb-3 font-mono text-sm font-semibold">{file.name}</h2>
      <FileBody repo={repo} file={file} />
    </section>
  )
}

/** The directory or file at `path`, with the breadcrumb that leads back up. */
export function RepoFiles({ repo, name, path }: { repo: RepoLocator; name: string; path: EncodedPath }) {
  const [params] = useSearchParams()
  const cursor = params.get("cursor") ?? ""
  const line = windowStart(params)
  const files = useResource(`files ${repoKey(repo)} ${path} ${cursor} ${line}`, (signal) => getFiles(repo, { path, cursor, line }, { signal }))
  return (
    <>
      <PathCrumbs repo={repo} name={name} path={path} />
      {files.kind === "loading" && <LoadingState>Loading files…</LoadingState>}
      {files.kind === "failed" && (
        files.error.code === "not_found" ? (
          <EmptyState title="No such file or directory"><Link to={repoRoute(repo)} className={linkClass}>Go to the repository's root</Link></EmptyState>
        ) : files.error.code === "validation" ? (
          <EmptyState title="This file has no such line"><Link to={repoRoute(repo, path)} className={linkClass}>Show the file from its start</Link></EmptyState>
        ) : (
          <FailureState title="Couldn't load files" error={files.error} onRetry={files.reload} />
        )
      )}
      {files.kind === "loaded" && (files.data.kind === "dir" ? <Directory repo={repo} listing={files.data} cursor={cursor} /> : <FileSection repo={repo} file={files.data} />)}
    </>
  )
}
