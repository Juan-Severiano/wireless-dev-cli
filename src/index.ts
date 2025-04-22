import { program } from 'commander';
import { exec, execSync } from 'child_process';
import inquirer from 'inquirer';
import qrcode from 'qrcode-terminal';
import os from 'os';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { promisify } from 'util';
import { networkInterfaces } from 'os';
import fs from 'fs';
import path from 'path';

const execPromise = promisify(exec);

interface DeviceInfo {
  id: string;
  status: string;
  model?: string;
  androidVersion?: string;
  manufacturer?: string;
  wireless?: boolean;
}

interface DiscoveredDevice {
  ip: string;
  status: string;
}

interface KnownDevice {
  id: string;
  ip: string;
  model: string;
  lastConnected: string;
}

interface ConfigType {
  knownDevices?: KnownDevice[];
}

const CONFIG_DIR = path.join(os.homedir(), '.wireless-dev');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR);
}

let config: ConfigType = {};
try {
  if (fs.existsSync(CONFIG_FILE)) {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
} catch (err) {
  console.error('Error loading config:', err);
}

const saveConfig = (): void => {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
};

const getLocalIpAddress = (): string => {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    const networkInterface = nets[name];
    if (networkInterface) {
      for (const net of networkInterface) {
        if (net.family === 'IPv4' && !net.internal) {
          return net.address;
        }
      }
    }
  }
  return '127.0.0.1';
};

const getConnectedDevices = async (): Promise<DeviceInfo[]> => {
  try {
    const { stdout } = await execPromise('adb devices');
    const lines = stdout.split('\n').slice(1);
    const devices: DeviceInfo[] = [];
    
    for (const line of lines) {
      const match = line.match(/^(\S+)\s+(\S+)/);
      if (match) {
        const [, id, status] = match;
        
        let deviceInfo: DeviceInfo = { id, status };
        
        if (status === 'device') {
          try {
            const { stdout: model } = await execPromise(`adb -s ${id} shell getprop ro.product.model`);
            deviceInfo.model = model.trim();
            
            const { stdout: version } = await execPromise(`adb -s ${id} shell getprop ro.build.version.release`);
            deviceInfo.androidVersion = version.trim();
            
            const { stdout: manufacturer } = await execPromise(`adb -s ${id} shell getprop ro.product.manufacturer`);
            deviceInfo.manufacturer = manufacturer.trim();
            
            deviceInfo.wireless = id.includes(':');
          } catch (err) {
          }
        }
        
        devices.push(deviceInfo);
      }
    }
    
    return devices;
  } catch (error) {
    console.error('Error getting devices:', error);
    return [];
  }
};

const discoverDevices = async (): Promise<DiscoveredDevice[]> => {
  const spinner = ora('Discovering devices on network...').start();
  
  try {
    const localIp = getLocalIpAddress();
    const ipBase = localIp.substring(0, localIp.lastIndexOf('.') + 1);
    
    const discoveredDevices: DiscoveredDevice[] = [];
    const promises: Promise<void>[] = [];
    
    for (let i = 1; i < 255; i++) {
      const ip = `${ipBase}${i}`;
      
      const connectedDevices = await getConnectedDevices();
      const isAlreadyConnected = connectedDevices.some(device => 
        device.id.includes(ip) || device.id.startsWith(ip)
      );
      
      if (isAlreadyConnected) {
        discoveredDevices.push({ ip, status: 'connected' });
      } else if (ip === localIp) {
        continue;
      } else {
        promises.push(
          execPromise(`adb connect ${ip}:5555`, { timeout: 500 })
            .then(() => {
              discoveredDevices.push({ ip, status: 'discoverable' });
            })
            .catch(() => {
            })
        );
      }
    }
    
    await Promise.allSettled(promises);
    spinner.succeed('Device discovery completed');
    return discoveredDevices;
  } catch (error) {
    spinner.fail('Device discovery failed');
    console.error('Error discovering devices:', error);
    return [];
  }
};

const checkAdbInstalled = (): boolean => {
  try {
    execSync('adb version', { stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
};

const enableWirelessDebugging = async (deviceId: string): Promise<boolean> => {
  try {
    const devices = await getConnectedDevices();
    const device = devices.find(d => d.id === deviceId);
    
    if (!device) {
      console.error(chalk.red(`Device ${deviceId} not found`));
      return false;
    }
    
    if (device.wireless) {
      console.log(chalk.yellow(`Device ${deviceId} is already connected wirelessly`));
      return true;
    }
    const { stdout: version } = await execPromise(`adb -s ${deviceId} shell getprop ro.build.version.release`);
    const androidVersion = parseInt(version.trim().split('.')[0]);
    
    if (androidVersion >= 11) {
      console.log(chalk.blue('Using Android 11+ wireless debugging...'));
      
      const { stdout: wifiIp } = await execPromise(`adb -s ${deviceId} shell ip route | grep wlan0 | awk '{print $9}'`);
      const ip = wifiIp.trim();
      
      if (!ip) {
        console.error(chalk.red('Failed to get device IP address. Make sure Wi-Fi is enabled.'));
        return false;
      }
      
      await execPromise(`adb -s ${deviceId} tcpip 5555`);
      
      console.log(chalk.green(`Wireless debugging enabled. Device IP: ${ip}`));
      console.log(chalk.blue(`Wait a few seconds and then connect with: adb connect ${ip}:5555`));
      
      if (!config.knownDevices) config.knownDevices = [];
      config.knownDevices.push({
        id: deviceId,
        ip: `${ip}:5555`,
        model: device.model || 'Unknown',
        lastConnected: new Date().toISOString()
      });
      saveConfig();
      
      return true;
    } else {
      console.log(chalk.yellow('Using legacy wireless debugging for Android 10 and below...'));
      
      const { stdout: wifiIp } = await execPromise(`adb -s ${deviceId} shell ip addr show wlan0 | grep "inet " | cut -d' ' -f6 | cut -d/ -f1`);
      const ip = wifiIp.trim();
      
      if (!ip) {
        console.error(chalk.red('Failed to get device IP address. Make sure Wi-Fi is enabled.'));
        return false;
      }
      
      await execPromise(`adb -s ${deviceId} tcpip 5555`);
      
      console.log(chalk.green(`Wireless debugging enabled. Device IP: ${ip}`));
      console.log(chalk.blue(`Wait a few seconds and then connect with: adb connect ${ip}:5555`));
      
      if (!config.knownDevices) config.knownDevices = [];
      config.knownDevices.push({
        id: deviceId,
        ip: `${ip}:5555`,
        model: device.model || 'Unknown',
        lastConnected: new Date().toISOString()
      });
      saveConfig();
      
      return true;
    }
  } catch (error) {
    console.error('Error enabling wireless debugging:', error);
    return false;
  }
};

const connectToDevice = async (ipAndPort: string): Promise<boolean> => {
  try {
    const { stdout } = await execPromise(`adb connect ${ipAndPort}`);
    console.log(chalk.green(stdout.trim()));
    
    if (stdout.includes('connected')) {
      if (config.knownDevices) {
        const deviceIndex = config.knownDevices.findIndex(d => d.ip === ipAndPort);
        if (deviceIndex !== -1) {
          config.knownDevices[deviceIndex].lastConnected = new Date().toISOString();
          saveConfig();
        }
      }
      return true;
    }
    return false;
  } catch (error) {
    console.error('Error connecting to device:', error);
    return false;
  }
};

const disconnectDevice = async (ipAndPort: string): Promise<boolean> => {
  try {
    const { stdout } = await execPromise(`adb disconnect ${ipAndPort}`);
    console.log(chalk.yellow(stdout.trim()));
    return true;
  } catch (error) {
    console.error('Error disconnecting from device:', error);
    return false;
  }
};

const getRunningServices = async (deviceId: string): Promise<string[]> => {
  try {
    const { stdout } = await execPromise(`adb -s ${deviceId} shell "ps | grep -E 'app_process|react|expo|metro'"`);
    return stdout.split('\n').filter(line => line.trim() !== '');
  } catch (error) {
    return [];
  }
};

const generateConnectionQr = (ip: string, port = 5555): void => {
  const connectionString = `adbwireless://${ip}:${port}`;
  console.log(chalk.blue(`Scan this QR code on your device to connect wirelessly:`));
  qrcode.generate(connectionString, { small: true });
  console.log(chalk.blue(`Or connect manually with: adb connect ${ip}:${port}`));
};

program
  .name('wireless-dev')
  .description('CLI tool for wireless React Native/Expo development')
  .version('1.0.0');

program
  .command('list')
  .description('List all connected devices')
  .action(async () => {
    if (!checkAdbInstalled()) {
      console.error(chalk.red('ADB is not installed or not in PATH. Please install Android SDK and add ADB to your PATH.'));
      return;
    }
    
    const spinner = ora('Getting connected devices...').start();
    try {
      const devices = await getConnectedDevices();
      spinner.stop();
      
      if (devices.length === 0) {
        console.log(chalk.yellow('No devices connected. Use "wireless-dev discover" to find devices.'));
        return;
      }
      
      const table = new Table({
        head: ['Device ID', 'Status', 'Model', 'Android', 'Type'],
        colWidths: [30, 15, 25, 10, 10]
      });
      
      devices.forEach(device => {
        table.push([
          device.id,
          chalk.green(device.status),
          device.model || 'Unknown',
          device.androidVersion || 'N/A',
          device.wireless ? chalk.blue('Wireless') : chalk.yellow('USB')
        ]);
      });
      
      console.log(table.toString());
    } catch (error) {
      spinner.fail('Failed to get devices');
      console.error('Error:', error);
    }
  });

program
  .command('discover')
  .description('Discover devices on the network')
  .action(async () => {
    if (!checkAdbInstalled()) {
      console.error(chalk.red('ADB is not installed or not in PATH. Please install Android SDK and add ADB to your PATH.'));
      return;
    }
    
    try {
      const devices = await discoverDevices();
      
      if (devices.length === 0) {
        console.log(chalk.yellow('No devices discoverable on the network. Make sure they have wireless debugging enabled.'));
        return;
      }
      
      const table = new Table({
        head: ['IP Address', 'Status'],
        colWidths: [20, 15]
      });
      
      devices.forEach(device => {
        table.push([
          device.ip,
          device.status === 'connected' ? chalk.green('Connected') : chalk.blue('Discoverable')
        ]);
      });
      
      console.log(table.toString());
    } catch (error) {
      console.error('Error discovering devices:', error);
    }
  });

program
  .command('connect')
  .description('Connect to a device wirelessly')
  .option('-i, --ip <ip>', 'Device IP address and port (e.g., 192.168.1.100:5555)')
  .action(async (options: { ip?: string }) => {
    if (!checkAdbInstalled()) {
      console.error(chalk.red('ADB is not installed or not in PATH. Please install Android SDK and add ADB to your PATH.'));
      return;
    }
    
    try {
      let ipAndPort = options.ip;
      
      if (!ipAndPort) {
        if (config.knownDevices && config.knownDevices.length > 0) {
          const { device } = await inquirer.prompt([
            {
              type: 'list',
              name: 'device',
              message: 'Select a device to connect to:',
              choices: config.knownDevices.map(device => ({
                name: `${device.model || 'Unknown'} (${device.ip})`,
                value: device.ip
              }))
            }
          ]);
          ipAndPort = device;
        } else {
          const { ip } = await inquirer.prompt([
            {
              type: 'input',
              name: 'ip',
              message: 'Enter device IP and port (e.g., 192.168.1.100:5555):',
              validate: (input: string) => {
                if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/.test(input)) {
                  return true;
                }
                return 'Please enter a valid IP address and optional port';
              }
            }
          ]);
          ipAndPort = ip;
        }
      }
      
      if (!ipAndPort?.includes(':')) {
        ipAndPort = `${ipAndPort}:5555`;
      }
      
      const spinner = ora(`Connecting to ${ipAndPort}...`).start();
      const connected = await connectToDevice(ipAndPort);
      
      if (connected) {
        spinner.succeed(`Connected to ${ipAndPort}`);
      } else {
        spinner.fail(`Failed to connect to ${ipAndPort}`);
      }
    } catch (error) {
      console.error('Error connecting to device:', error);
    }
  });

program
  .command('disconnect')
  .description('Disconnect from a wireless device')
  .option('-i, --ip <ip>', 'Device IP address and port (e.g., 192.168.1.100:5555)')
  .action(async (options: { ip?: string }) => {
    if (!checkAdbInstalled()) {
      console.error(chalk.red('ADB is not installed or not in PATH. Please install Android SDK and add ADB to your PATH.'));
      return;
    }
    
    try {
      let ipAndPort = options.ip;
      
      if (!ipAndPort) {
        const devices = await getConnectedDevices();
        const wirelessDevices = devices.filter(device => device.wireless);
        
        if (wirelessDevices.length === 0) {
          console.log(chalk.yellow('No wireless devices connected.'));
          return;
        }
        
        const { device } = await inquirer.prompt([
          {
            type: 'list',
            name: 'device',
            message: 'Select a device to disconnect:',
            choices: wirelessDevices.map(device => ({
              name: `${device.model || 'Unknown'} (${device.id})`,
              value: device.id
            }))
          }
        ]);
        ipAndPort = device;
      }
      
      const spinner = ora(`Disconnecting from ${ipAndPort}...`).start();
      const disconnected = await disconnectDevice(ipAndPort!);
      
      if (disconnected) {
        spinner.succeed(`Disconnected from ${ipAndPort}`);
      } else {
        spinner.fail(`Failed to disconnect from ${ipAndPort}`);
      }
    } catch (error) {
      console.error('Error disconnecting from device:', error);
    }
  });

program
  .command('enable-wireless')
  .description('Enable wireless debugging on a USB connected device')
  .option('-d, --device <deviceId>', 'Device ID (from adb devices)')
  .action(async (options: { device?: string }) => {
    if (!checkAdbInstalled()) {
      console.error(chalk.red('ADB is not installed or not in PATH. Please install Android SDK and add ADB to your PATH.'));
      return;
    }
    
    try {
      let deviceId = options.device;
      
      if (!deviceId) {
        const devices = await getConnectedDevices();
        const usbDevices = devices.filter(device => !device.wireless && device.status === 'device');
        
        if (usbDevices.length === 0) {
          console.log(chalk.yellow('No USB devices connected. Connect a device via USB first.'));
          return;
        }
        
        const { device } = await inquirer.prompt([
          {
            type: 'list',
            name: 'device',
            message: 'Select a USB device to enable wireless debugging:',
            choices: usbDevices.map(device => ({
              name: `${device.model || 'Unknown'} (${device.id})`,
              value: device.id
            }))
          }
        ]);
        deviceId = device;
      }
      
      const spinner = ora(`Enabling wireless debugging on ${deviceId}...`).start();
      const enabled = await enableWirelessDebugging(deviceId!);
      
      if (enabled) {
        spinner.succeed(`Wireless debugging enabled on ${deviceId}`);
      } else {
        spinner.fail(`Failed to enable wireless debugging on ${deviceId}`);
      }
    } catch (error) {
      console.error('Error enabling wireless debugging:', error);
    }
  });

program
  .command('info')
  .description('Show details of connected device(s)')
  .option('-d, --device <deviceId>', 'Device ID (from adb devices)')
  .action(async (options: { device?: string }) => {
    if (!checkAdbInstalled()) {
      console.error(chalk.red('ADB is not installed or not in PATH. Please install Android SDK and add ADB to your PATH.'));
      return;
    }
    
    try {
      let deviceId = options.device;
      let devices = await getConnectedDevices();
      
      if (devices.length === 0) {
        console.log(chalk.yellow('No devices connected.'));
        return;
      }
      
      if (deviceId) {
        devices = devices.filter(device => device.id === deviceId);
        
        if (devices.length === 0) {
          console.log(chalk.red(`Device ${deviceId} not found.`));
          return;
        }
      } else if (devices.length > 1) {
        const { device } = await inquirer.prompt([
          {
            type: 'list',
            name: 'device',
            message: 'Select a device to show info:',
            choices: devices.map(device => ({
              name: `${device.model || 'Unknown'} (${device.id})`,
              value: device.id
            }))
          }
        ]);
        deviceId = device;
        devices = devices.filter(d => d.id === deviceId);
      }
      
      const device = devices[0];
      
      console.log(chalk.green('\n==== Device Information ===='));
      console.log(chalk.blue(`ID: `) + device.id);
      console.log(chalk.blue(`Status: `) + device.status);
      console.log(chalk.blue(`Model: `) + (device.model || 'Unknown'));
      console.log(chalk.blue(`Manufacturer: `) + (device.manufacturer || 'Unknown'));
      console.log(chalk.blue(`Android Version: `) + (device.androidVersion || 'Unknown'));
      console.log(chalk.blue(`Connection Type: `) + (device.wireless ? 'Wireless' : 'USB'));
      
      console.log(chalk.green('\n==== Running Development Services ===='));
      const services = await getRunningServices(device.id);
      
      if (services.length === 0) {
        console.log(chalk.yellow('No React Native/Expo services detected.'));
      } else {
        services.forEach(service => {
          console.log(service);
        });
      }
      
      try {
        const { stdout: packages } = await execPromise(`adb -s ${device.id} shell pm list packages | grep -E 'react|expo|debug'`);
        console.log(chalk.green('\n==== Installed Development Packages ===='));
        if (packages.trim()) {
          packages.split('\n').forEach(pkg => {
            if (pkg.trim()) {
              console.log(pkg.replace('package:', '').trim());
            }
          });
        } else {
          console.log(chalk.yellow('No development packages detected.'));
        }
      } catch (error) {
        console.log(chalk.yellow('No development packages detected.'));
      }
    } catch (error) {
      console.error('Error showing device info:', error);
    }
  });

program
  .command('qr')
  .description('Generate QR code for wireless connection')
  .option('-d, --device <deviceId>', 'Device ID to generate QR code for (must be connected via USB)')
  .action(async (options: { device?: string }) => {
    if (!checkAdbInstalled()) {
      console.error(chalk.red('ADB is not installed or not in PATH. Please install Android SDK and add ADB to your PATH.'));
      return;
    }
    
    try {
      if (options.device) {
        await enableWirelessDebugging(options.device);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      const localIp = getLocalIpAddress();
      
      
      console.log(chalk.yellow('\nNote: On your device, you need a QR scanner app that can handle "adbwireless://" protocol.'));
      console.log(chalk.yellow('For some devices, you may need to connect manually with the command shown above.'));
    } catch (error) {
      console.error('Error generating QR code:', error);
    }
  });

program
  .command('expo-start')
  .description('Start Expo development server with QR code for wireless connection')
  .option('-d, --device <deviceId>', 'Device ID to connect (must be already wireless or connected via USB)')
  .action(async (options: { device?: string }) => {
    if (!checkAdbInstalled()) {
      console.error(chalk.red('ADB is not installed or not in PATH. Please install Android SDK and add ADB to your PATH.'));
      return;
    }
    
    try {
      if (options.device) {
        const devices = await getConnectedDevices();
        const device = devices.find(d => d.id === options.device);
        
        if (device && !device.wireless) {
          console.log(chalk.blue('Device is connected via USB. Enabling wireless debugging...'));
          await enableWirelessDebugging(options.device);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      
      const localIp = getLocalIpAddress();
      
      console.log(chalk.green(`Starting Expo server on ${localIp}...`));
      console.log(chalk.blue('This will automatically use the wireless connection for your device.'));
      
      const expoProcess = exec(`npx expo start --host ${localIp}`);
      
      expoProcess.stdout?.on('data', (data) => {
        console.log(data);
      });
      
      expoProcess.stderr?.on('data', (data) => {
        console.error(chalk.red(data));
      });
      
      process.on('SIGINT', () => {
        expoProcess.kill();
        process.exit();
      });
    } catch (error) {
      console.error('Error starting Expo server:', error);
    }
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
