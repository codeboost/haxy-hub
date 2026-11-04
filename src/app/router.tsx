import { createBrowserRouter } from "react-router"
import { AppShell } from "@/app/AppShell"
import { ConnectionPage } from "@/pages/ConnectionPage"
import { HomePage } from "@/pages/HomePage"
import { NotFoundPage } from "@/pages/NotFoundPage"

// Every view is identified by its URL, so a refresh or a shared link
// reconstructs it. Vite's dev and preview servers fall back to index.html
// for unknown paths; a production host must do the same.
export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "connection", element: <ConnectionPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
])
