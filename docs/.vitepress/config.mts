import { defineConfig } from "vitepress";

export default defineConfig({
  lang: "en-US",
  base: process.env.GITHUB_ACTIONS === "true" ? "/tether/" : "/",
  title: "Tether",
  description: "Persistent remote-shell console — documentation",
  sitemap: { hostname: "https://samlo.cloud/tether/" },
  cleanUrls: true,
  appearance: false,
  themeConfig: {
    logo: { src: "/icon.svg", alt: "Tether" },
    nav: [
      { text: "Using Tether", link: "/getting-started" },
      { text: "Development", link: "/architecture" },
    ],
    sidebar: [
      {
        text: "Using Tether",
        items: [
          { text: "Getting started", link: "/getting-started" },
          { text: "Desktop app", link: "/desktop" },
          { text: "Terminal basics", link: "/terminal/basics" },
          { text: "Sessions & tabs", link: "/terminal/sessions" },
          { text: "Saved commands & search", link: "/terminal/saved-commands" },
          { text: "Git, files & previews", link: "/workspace" },
          { text: "Security & networking", link: "/security" },
          { text: "Reach from anywhere", link: "/reach-from-anywhere" },
          { text: "Privacy", link: "/privacy" },
          { text: "Updating & data", link: "/updating" },
          { text: "Changelog", link: "/changelog" },
        ],
      },
      {
        text: "Development",
        items: [
          { text: "Architecture", link: "/architecture" },
          { text: "Data flow", link: "/data-flow" },
          { text: "Decisions", link: "/decisions" },
          { text: "Contributing", link: "/development/contributing" },
          { text: "Desktop signing", link: "/development/desktop-signing" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/samuelloranger/tether" }],
    outline: [2, 3],
  },
});
