import { RouterProvider } from "react-router/dom"
import { ConnectionProvider } from "@/app/connection"
import { router } from "@/app/router"

export default function App() {
  return (
    <ConnectionProvider>
      <RouterProvider router={router} />
    </ConnectionProvider>
  )
}
