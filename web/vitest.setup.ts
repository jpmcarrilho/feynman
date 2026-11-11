import '@testing-library/jest-dom'

// Files that opt into the node environment (route handler tests) have no window
if (typeof window !== 'undefined') {
  window.HTMLElement.prototype.scrollIntoView = function() {};
}
