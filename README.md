# Azure-IoT-Simulation
A cloud system test project trying out azure applications 

This project uses a node.js program to simulate an IoT device sending telemetry data over a Wifi connection using Azure IoT SDK and MQTT Transport
https://github.com/Azure/azure-iot-sdk-node

From there automatically provisioning devices to Azure' Saas solution IoT Central through its built in DPS (Device Provisioning Service) using an enrollment group

Once provisioned telemetry data is streamed into IoT Central where it is stored for a short period of time.
From there the "devices" are exported to an EventHub inorder to connect to realtime streaming using Fabric's EventStream 
After the connection is set up the EventStream is connected to a Lakehouse for storage before being visualized using PowerBI

# Applications Used 
- Iot Central
- Fabric
  - EventStream
  - Lakehouse
- PowerBI
- EventHub
