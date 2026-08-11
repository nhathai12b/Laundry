/**
 * Memory monitoring utility
 * Logs memory usage periodically and provides memory stats
 */

export const getMemoryUsage = () => {
  const usage = process.memoryUsage();
  return {
    rss: Math.round(usage.rss / 1024 / 1024), // Total memory (MB)
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024), // Heap total (MB)
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024), // Heap used (MB)
    external: Math.round(usage.external / 1024 / 1024), // External (MB)
  };
};

export const getMemoryUsageFormatted = () => {
  const usage = getMemoryUsage();
  return {
    rss: `${usage.rss} MB`,
    heapTotal: `${usage.heapTotal} MB`,
    heapUsed: `${usage.heapUsed} MB`,
    external: `${usage.external} MB`,
  };
};

/**
 * Start periodic memory logging
 * @param {number} intervalMinutes - Log interval in minutes (default: 5)
 */
export const startMemoryMonitoring = (intervalMinutes = 5) => {
  const intervalMs = intervalMinutes * 60 * 1000;
  
  setInterval(() => {
    const usage = getMemoryUsage();
    const uptime = Math.round(process.uptime());
    const uptimeHours = Math.floor(uptime / 3600);
    const uptimeMinutes = Math.floor((uptime % 3600) / 60);
    
    console.log(`[Memory Monitor] RSS: ${usage.rss}MB | Heap: ${usage.heapUsed}/${usage.heapTotal}MB | Uptime: ${uptimeHours}h ${uptimeMinutes}m`);
    
    // Warning if memory usage is high
    if (usage.rss > 500) {
      console.warn(`[Memory Warning] High memory usage detected: ${usage.rss}MB`);
    }
  }, intervalMs);
  
  console.log(`[Memory Monitor] Started - logging every ${intervalMinutes} minutes`);
};
