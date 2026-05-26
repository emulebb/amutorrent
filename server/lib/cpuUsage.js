/**
 * CPU Usage Utility
 * Reads CPU usage from /proc/stat where available, otherwise from Node's OS CPU counters.
 * Works natively on Windows and inside Docker/Linux.
 */

const fs = require('fs').promises;
const os = require('os');

let previousCpuInfo = null;

/**
 * Parse CPU times from /proc/stat
 * @returns {Object} CPU times breakdown
 */
async function readCpuTimesFromProc() {
    try {
        const content = await fs.readFile('/proc/stat', 'utf8');
        const lines = content.split('\n');

        // First line is aggregate CPU stats
        const cpuLine = lines.find(line => line.startsWith('cpu '));
        if (!cpuLine) {
            return null;
        }

        // cpu  user nice system idle iowait irq softirq steal guest guest_nice
        const parts = cpuLine.split(/\s+/).slice(1).map(Number);

        const [user, nice, system, idle, iowait, irq, softirq, steal] = parts;

        const idleTime = idle + iowait;
        const totalTime = user + nice + system + idle + iowait + irq + softirq + steal;

        return { idleTime, totalTime };
    } catch (err) {
        return null;
    }
}

function readCpuTimesFromOsCpus(cpus = os.cpus()) {
    if (!Array.isArray(cpus) || cpus.length === 0) {
        return null;
    }

    let idleTime = 0;
    let totalTime = 0;
    for (const cpu of cpus) {
        const times = cpu && cpu.times;
        if (!times) {
            return null;
        }
        const user = Number(times.user) || 0;
        const nice = Number(times.nice) || 0;
        const sys = Number(times.sys) || 0;
        const idle = Number(times.idle) || 0;
        const irq = Number(times.irq) || 0;
        idleTime += idle;
        totalTime += user + nice + sys + idle + irq;
    }

    if (totalTime <= 0) {
        return null;
    }
    return { idleTime, totalTime };
}

async function readCpuTimes() {
    if (process.platform !== 'win32') {
        const procTimes = await readCpuTimesFromProc();
        if (procTimes) {
            return procTimes;
        }
    }
    return readCpuTimesFromOsCpus();
}

/**
 * Get CPU usage percentage
 * Compares current reading with previous to calculate usage
 * @returns {Object} CPU usage info
 */
async function getCpuUsage() {
    try {
        const currentCpuInfo = await readCpuTimes();

        if (!currentCpuInfo) {
            return { percent: 0, error: 'Could not read CPU stats' };
        }

        if (!previousCpuInfo) {
            // First call - store current and return 0
            previousCpuInfo = currentCpuInfo;
            return { percent: 0 };
        }

        const idleDelta = currentCpuInfo.idleTime - previousCpuInfo.idleTime;
        const totalDelta = currentCpuInfo.totalTime - previousCpuInfo.totalTime;

        // Store current for next call
        previousCpuInfo = currentCpuInfo;

        if (totalDelta === 0) {
            return { percent: 0 };
        }

        const usagePercent = Math.round(((totalDelta - idleDelta) / totalDelta) * 100);

        return {
            percent: Math.max(0, Math.min(100, usagePercent))
        };
    } catch (err) {
        return { percent: 0, error: err.message };
    }
}

module.exports = {
    getCpuUsage,
    _readCpuTimesFromOsCpus: readCpuTimesFromOsCpus
};
