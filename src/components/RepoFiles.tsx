import { useEffect, useState, type ReactNode } from "react"
import { Link, useLocation, useSearchParams } from "react-router"
import { File, Folder, CornerLeftUp, History } from "lucide-react"
import { EmptyState, FailureState, Pager } from "@/components/listing"
import { CodeLine } from "@/components/CodeLine"
import { Markdown } from "@/components/Markdown"
import { useHighlightedLines } from "@/lib/highlight"
import { languageForFile } from "@/lib/languages"
import type { LinkTarget } from "@/lib/markdown"
import { RepoToolbar } from "@/components/RepoToolbar"
import { commitRoute, commitsRoute } from "@/lib/commits"
import { displaySegment, getFiles, parentPath, pathSegments, repoLinkPath, repoRoute, type DirListing, type EncodedPath, type FileView, type GitCommand, type ReadRef, type RefId, type RepoLocator } from "@/lib/repo"
import { useResource } from "@/lib/resource"

// A repository's files at the default branch or the ref the URL names. The
// URL holds everything a view shows: the path (encoded exactly as Haxy
// encodes it), the `ref`, a directory page's `cursor`, a file window's first
// `line`, and the selected line as `#L<n>`, so refresh and shared links
// reconstruct it. Every link keeps the URL's ref, so a view at a branch
// follows that branch and the default view keeps following the default.

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
function markdownLinks(repo: RepoLocator, ref: RefId | null, dir: EncodedPath): (destination: string) => LinkTarget {
  return (destination) => {
    const target = repoLinkPath(destination, dir)
    switch (target.kind) {
      case "external": return target
      case "repo": return { kind: "internal", to: repoRoute(repo, target.path, ref) }
      case "none": return target
    }
  }
}

/** The repository name, then each directory of `path`, each leading back up. */
function PathCrumbs({ repo, refId, name, path }: { repo: RepoLocator; refId: RefId | null; name: string; path: EncodedPath }) {
  const segments = pathSegments(path)
  return (
    <nav aria-label="Path" className="flex min-w-0 flex-wrap items-center gap-1 font-mono text-sm">
      {segments.length === 0 ? <span aria-current="page" className="font-semibold">{name}</span> : <Link to={repoRoute(repo, "", refId)} className={linkClass}>{name}</Link>}
      {segments.map((segment, index) => {
        const last = index === segments.length - 1
        return (
          <span key={index} className="flex items-center gap-1">
            <span aria-hidden className="text-muted-foreground">/</span>
            {last ? <span aria-current="page" className="font-semibold">{displaySegment(segment)}</span> : <Link to={repoRoute(repo, segments.slice(0, index + 1).join("/"), refId)} className={linkClass}>{displaySegment(segment)}</Link>}
          </span>
        )
      })}
    </nav>
  )
}

const shortIdLength = 7

/** The commit the view shows, and the history from it. */
function CommitLinks({ repo, refId, read }: { repo: RepoLocator; refId: RefId | null; read: ReadRef }) {
  const muted = "flex items-center gap-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
  return (
    <div className="flex shrink-0 items-center gap-4 text-sm">
      <Link to={commitRoute(repo, read.commit, refId)} title={read.commit} aria-label={`Commit ${read.commit}`} className={`${muted} font-mono text-xs hover:underline`}>{read.commit.slice(0, shortIdLength)}</Link>
      <Link to={commitsRoute(repo, refId)} className={muted}><History size={15} aria-hidden />History</Link>
    </div>
  )
}

/** The path on the left and the commit on the right, heading the directory listing it sits on. */
function PathBar({ attached, children }: { attached: boolean; children: ReactNode }) {
  return <div className={`mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border bg-secondary/60 px-4 py-2 ${attached ? "rounded-t-xl" : "rounded-xl"}`}>{children}</div>
}

function Directory({ repo, refId, listing, cursor, header }: { repo: RepoLocator; refId: RefId | null; listing: DirListing; cursor: string; header: (attached: boolean) => ReactNode }) {
  const listed = listing.items.length > 0 || cursor !== ""
  const rowClass = "flex items-center gap-2 px-4 py-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
  return (
    <>
      {header(listed)}
      {!listed ? (
        <EmptyState title="This directory is empty" />
      ) : (
        <ul aria-label="Files" className="divide-y rounded-b-xl border border-t-0 bg-card">
          {listing.path && (
            <li><Link to={repoRoute(repo, parentPath(listing.path), refId)} aria-label="Parent directory" className={rowClass}><CornerLeftUp size={16} aria-hidden className="text-muted-foreground" />..</Link></li>
          )}
          {listing.items.map((item) => (
            <li key={item.path}>
              <Link to={repoRoute(repo, item.path, refId)} className={rowClass}>
                {item.kind === "dir" ? <Folder size={16} aria-hidden className="text-primary" /> : <File size={16} aria-hidden className="text-muted-foreground" />}
                <span className="font-mono">{item.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Pager page={listing.page} search="" cursor={cursor} noun="Files" base={repoRoute(repo, listing.path, refId)} />
      {listing.readme && <Readme key={listing.readme.path} repo={repo} refId={refId} path={listing.readme.path} name={listing.readme.name} />}
    </>
  )
}

/** A directory's README, shown beneath its listing as the TUI shows it when the directory opens. */
function Readme({ repo, refId, path, name }: { repo: RepoLocator; refId: RefId | null; path: EncodedPath; name: string }) {
  const file = useResource(`readme ${repoKey(repo)} ${refId} ${path}`, (signal) => getFiles(repo, { path, ref: refId }, { signal }))
  const headingId = "readme-heading"
  return (
    <section aria-labelledby={headingId} className="mt-8 rounded-xl border bg-card">
      <h2 id={headingId} className="border-b px-4 py-2 font-mono text-sm font-semibold">{name}</h2>
      <div className="p-4 sm:p-6">
        {file.kind === "failed" && <FailureState title={`Couldn't load ${name}`} error={file.error} onRetry={file.reload} />}
        {file.kind === "loaded" && file.data.kind === "file" && <FileBody repo={repo} refId={refId} file={file.data} />}
      </div>
    </section>
  )
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US")
}

/** A file's content in whichever state it is: rendered Markdown, numbered lines, empty or binary. */
function FileBody({ repo, refId, file }: { repo: RepoLocator; refId: RefId | null; file: FileView }) {
  const { hash } = useLocation()
  const target = selectedLine(hash)
  const content = file.content
  // Window links and permalinks name the file itself, also where it shows
  // inside its directory (a README).
  const fileRoute = (line?: number) => repoRoute(repo, file.path, refId, line !== undefined && line > 1 ? { line: String(line) } : {})

  useEffect(() => {
    if (target === null) return
    document.getElementById(`L${target}`)?.scrollIntoView({ block: "center" })
  }, [target, file])

  if (content.kind === "empty") return <EmptyState title="This file is empty">It has no content at all.</EmptyState>
  if (content.kind === "binary") return <EmptyState title="Binary file not shown">Haxy only shows text files.</EmptyState>
  if (file.markdown) return <Markdown blocks={file.markdown} resolveLink={markdownLinks(repo, refId, parentPath(file.path))} />

  const end = content.start_line + content.lines.length - 1
  const partial = content.start_line > 1 || content.has_more
  const outside = target !== null && (target < content.start_line || target > end)
  return (
    <>
      {partial && (
        <p role="status" aria-label="Partial content" className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-2 text-sm">
          <span>Showing lines {formatNumber(content.start_line)}–{formatNumber(end)} of {formatNumber(content.total_lines)}.</span>
          {content.start_line > 1 && <Link to={fileRoute()} className={linkClass}>First lines</Link>}
          {content.next_line !== null && <Link to={fileRoute(content.next_line)} className={linkClass}>Next lines</Link>}
        </p>
      )}
      {outside && (
        <p className="mb-4 text-sm text-muted-foreground">
          Line {formatNumber(target)} isn't in this window. <Link to={`${fileRoute(target)}#L${target}`} className={linkClass}>Show line {target}</Link>
        </p>
      )}
      <CodeTable name={file.name} lines={content.lines} startLine={content.start_line} target={target} windowRoute={fileRoute(content.start_line)} />
    </>
  )
}

/** A window of a file's lines, numbered from `startLine`, each number a link to its line. */
function CodeTable({ name, lines, startLine, target, windowRoute }: { name: string; lines: string[]; startLine: number; target: number | null; windowRoute: string }) {
  const tokens = useHighlightedLines(lines, languageForFile(name))
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table aria-label={name} className="w-full border-collapse font-mono text-xs leading-5">
        <tbody>
          {lines.map((line, index) => {
            const number = startLine + index
            const current = number === target
            return (
              <tr key={number} id={`L${number}`} aria-current={current ? "location" : undefined} className={current ? "bg-amber-500/15" : undefined}>
                <td className="w-px border-r px-3 text-right align-top text-muted-foreground select-none">
                  <Link to={`${windowRoute}#L${number}`} aria-label={`Line ${number}`} preventScrollReset className="hover:text-foreground hover:underline">{number}</Link>
                </td>
                <td className="px-3 whitespace-pre"><CodeLine text={line} tokens={tokens?.[index]} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function FileSection({ repo, refId, file }: { repo: RepoLocator; refId: RefId | null; file: FileView }) {
  return (
    <section aria-labelledby="file-heading" className="mt-4">
      <h2 id="file-heading" className="mb-3 font-mono text-sm font-semibold">{file.name}</h2>
      <FileBody repo={repo} refId={refId} file={file} />
    </section>
  )
}

/**
 * The directory or file at `path`, read at `refId` (the default branch when
 * null), with the ref it shows and the breadcrumb that leads back up.
 */
export function RepoFiles({ repo, refId, name, path, clone }: { repo: RepoLocator; refId: RefId | null; name: string; path: EncodedPath; clone: GitCommand[] }) {
  const [params] = useSearchParams()
  const cursor = params.get("cursor") ?? ""
  const line = windowStart(params)
  const files = useResource(`files ${repoKey(repo)} ${refId} ${path} ${cursor} ${line}`, (signal) => getFiles(repo, { path, ref: refId, cursor, line }, { signal }))
  // the toolbar keeps the last ref read while the next path loads, rather than jumping away
  const loadedRef = files.kind === "loaded" ? files.data.ref : null
  const [read, setRead] = useState<ReadRef | null>(loadedRef)
  if (loadedRef !== null && loadedRef !== read) setRead(loadedRef)
  const pathBar = (attached: boolean) => (
    <PathBar attached={attached}>
      <PathCrumbs repo={repo} refId={refId} name={name} path={path} />
      {read && <CommitLinks repo={repo} refId={refId} read={read} />}
    </PathBar>
  )
  return (
    <>
      {read && <RepoToolbar repo={repo} path={path} refId={refId} read={read} clone={clone} />}
      {!(files.kind === "loaded" && files.data.kind === "dir") && pathBar(false)}
      {files.kind === "failed" && (
        files.error.code === "not_found" ? (
          refId === null ? (
            <EmptyState title="No such file or directory"><Link to={repoRoute(repo)} className={linkClass}>Go to the repository's root</Link></EmptyState>
          ) : (
            // the ref or the path may be what's missing; Haxy's message says which
            <EmptyState title="Nothing here at this ref">
              {files.error.message}{" "}
              <Link to={repoRoute(repo, "", refId)} className={linkClass}>Go to the root at this ref</Link> or <Link to={repoRoute(repo, path)} className={linkClass}>view this path on the default branch</Link>.
            </EmptyState>
          )
        ) : files.error.code === "validation" ? (
          files.error.fieldError("ref") ? (
            <EmptyState title="This isn't a ref Haxy knows how to read">{files.error.fieldError("ref")} <Link to={repoRoute(repo, path)} className={linkClass}>View this path on the default branch</Link></EmptyState>
          ) : (
            <EmptyState title="This file has no such line"><Link to={repoRoute(repo, path, refId)} className={linkClass}>Show the file from its start</Link></EmptyState>
          )
        ) : (
          <FailureState title="Couldn't load files" error={files.error} onRetry={files.reload} />
        )
      )}
      {files.kind === "loaded" && (files.data.kind === "dir" ? <Directory repo={repo} refId={refId} listing={files.data} cursor={cursor} header={pathBar} /> : <FileSection repo={repo} refId={refId} file={files.data} />)}
    </>
  )
}
