// Vite serves any file with a `?raw` suffix as a string. Type those imports.
declare module "*?raw" {
  const content: string;
  export default content;
}
