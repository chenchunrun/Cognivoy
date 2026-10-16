/**
 * Debounce utility
 * Delays function execution until after wait milliseconds have elapsed since the last call
 */
export function debounce<Args extends unknown[]>(
  func: (...args: Args) => unknown,
  wait: number,
): (...args: Args) => void {
  let timeout: NodeJS.Timeout | null = null;

  return function executedFunction(...args: Args) {
    const later = () => {
      timeout = null;
      func(...args);
    };

    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(later, wait);
  };
}
