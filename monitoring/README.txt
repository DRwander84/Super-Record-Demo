Gaming Mode > Monitoring: optional sensor library
--------------------------------------------------
GPU values for NVIDIA cards, RAM, CPU usage and the CPU / GPU names work
out of the box. Windows itself does not expose the processor temperature or the
clocks and temperature of AMD / Intel graphics cards, so for those values copy
the LibreHardwareMonitor library into this folder:

  LibreHardwareMonitorLib.dll   (the .NET Framework 4.7.2 build)
  HidSharp.dll                  (and any other .dll shipped next to it)

The folder is searched in this order:
  <install folder>/resources/monitoring
  <app folder>/monitoring
  <current folder>/monitoring
  %APPDATA%/<app name>/monitoring

Run SUPER RECORD as administrator: the library needs it to read the
processor sensors, and Windows needs it for the real-time FPS reader.
