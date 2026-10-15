export function $<T extends HTMLElement = HTMLElement>(id: string) {
  return document.getElementById(id)! as T;
}
