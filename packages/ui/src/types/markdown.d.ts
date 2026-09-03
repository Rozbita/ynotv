// Declare markdown file imports with ?raw suffix
declare module '*.md?raw' {
    const content: string;
    export default content;
}

declare module '@root/*.md?raw' {
    const content: string;
    export default content;
}

// The Jellyfin bridge init script lives as a raw string inside the Tauri crate's
// jellyfin_web.rs; vitest loads it with ?raw so the item-isolation tests exercise
// the real embedded source rather than a copy.
declare module '*.rs?raw' {
    const content: string;
    export default content;
}
