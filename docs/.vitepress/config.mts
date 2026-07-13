import { defineConfig } from "vitepress";

export default defineConfig({
  lang: "en-US",
  base: process.env.GITHUB_ACTIONS === "true" ? "/tether/" : "/",
  title: "Tether",
  description: "Persistent remote-shell console — documentation",
  sitemap: { hostname: "https://samlo.cloud/tether/" },
  cleanUrls: true,
  appearance: false,
  // Internal planning docs live under docs/superpowers/ — keep them in the repo
  // but don't publish them on the site.
  srcExclude: ["superpowers/**"],
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
          { text: "Security & networking", link: "/security" },
          { text: "Updating & data", link: "/updating" },
        ],
      },
      {
        text: "Development",
        items: [
          { text: "Architecture", link: "/architecture" },
          { text: "Data flow", link: "/data-flow" },
          { text: "Decisions", link: "/decisions" },
          { text: "Contributing", link: "/development/contributing" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/samuelloranger/tether" }],
    outline: [2, 3],
  },
});
