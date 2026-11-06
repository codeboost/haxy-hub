import { createBrowserRouter } from "react-router"
import { AppShell } from "@/app/AppShell"
import { AboutPage } from "@/pages/AboutPage"
import { AccountPage } from "@/pages/AccountPage"
import { ConnectionPage } from "@/pages/ConnectionPage"
import { HomePage } from "@/pages/HomePage"
import { LoginPage } from "@/pages/LoginPage"
import { NewRepoPage } from "@/pages/NewRepoPage"
import { NotFoundPage } from "@/pages/NotFoundPage"
import { NotificationsPage } from "@/pages/NotificationsPage"
import { repoRoutes } from "@/pages/RepoPage"
import { RegisterPage } from "@/pages/RegisterPage"
import { UserPage } from "@/pages/UserPage"
import { UsersPage } from "@/pages/UsersPage"

// Every view is identified by its URL, so a refresh or a shared link
// reconstructs it. Vite's dev and preview servers fall back to index.html
// for unknown paths; a production host must do the same.
export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "connection", element: <ConnectionPage /> },
      { path: "about", element: <AboutPage /> },
      { path: "users", element: <UsersPage /> },
      { path: "users/:name", element: <UserPage /> },
      { path: "login", element: <LoginPage /> },
      { path: "repos/new", element: <NewRepoPage /> },
      ...repoRoutes,
      { path: "register", element: <RegisterPage /> },
      { path: "account", element: <AccountPage /> },
      { path: "notifications", element: <NotificationsPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
])
