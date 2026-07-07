export function fetchMock(data, delay = 300) {
  return new Promise((resolve) => setTimeout(() => resolve(data), delay))
}
