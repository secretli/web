import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import Layout from "./components/Layout";
import HowItWorksPage from "./pages/HowItWorksPage";
import NotFoundPage from "./pages/NotFoundPage";
import RetrievePage from "./pages/RetrievePage";
import SharePage from "./pages/SharePage";

/**
 * The share page, started afresh by every navigation to it: the logo and
 * the Share link lead to an empty composer with the default settings, also
 * from the share page itself, where React would otherwise keep the page as
 * it was. Every navigation, even to the current address, has a new key.
 */
function FreshSharePage() {
  const location = useLocation();
  return <SharePage key={location.key} />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<FreshSharePage />} />
          <Route path="share" element={<FreshSharePage />} />
          {/* Files are shared from the same page now; old links still land. */}
          <Route path="file" element={<Navigate to="/share" replace />} />
          {/* Keyed: switching between /s and /c starts the page afresh. */}
          <Route path="s" element={<RetrievePage key="s" />} />
          <Route path="c" element={<RetrievePage key="c" />} />
          <Route path="how" element={<HowItWorksPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
