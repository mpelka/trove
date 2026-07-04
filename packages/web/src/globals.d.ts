// Bun bundles these at runtime; declare them so tsc is happy.
declare module "*.css";
declare module "*.html" {
  const html: import("bun").HTMLBundle;
  export default html;
}
