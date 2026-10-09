import { createRoot } from "react-dom/client";
import LettersPage from "./LettersPage.jsx";

// service worker 只做推送，不缓存
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

createRoot(document.getElementById("root")).render(<LettersPage />);
