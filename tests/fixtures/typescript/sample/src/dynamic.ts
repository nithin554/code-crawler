export async function loadPlugin(name: string) {
  const mod = await import(`./plugins/${name}`);
  return (mod as { Plugin: new () => { run(): string } }).Plugin;
}
