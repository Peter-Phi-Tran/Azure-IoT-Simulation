# Azure IoT Simulation

![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white)
![ESP32](https://img.shields.io/badge/ESP32-S3-blue?style=flat&logo=espressif)
![Azure](https://img.shields.io/badge/Microsoft%20Azure-0089D6?style=flat&logo=microsoft-azure&logoColor=white)
![MQTT](https://img.shields.io/badge/MQTT-0082C3?style=flat&logo=apache-kafka&logoColor=white)
![HTTPS](https://img.shields.io/badge/HTTPS-Secure-green?style=flat&logo=ssl)
![Power%20BI](https://img.shields.io/badge/Power%20BI-F2C811?style=flat&logo=power-bi&logoColor=black)

A project using cloud-based IoT system using various Azure services. It explores telemetry ingestion, transport protocols, and cloud data processing through both software and hardware emulation.

## Project Overview

This repository contains two separate simulation environments:

### 1. Node.js IoT Simulation (MQTT)
A Node.js application that mimics an IoT device sending telemetry data over Wi-Fi using the [Azure IoT SDK for Node.js](https://github.com/Azure/azure-iot-sdk-node) with MQTT transport.

### 2. ESP32-S3 Simulation on Wokwi (HTTPS)
A simulated ESP32-S3 device using [Wokwi](https://wokwi.com/) that transmits telemetry data over Wi-Fi via HTTPS using the [Azure IoT SDK for C](https://github.com/Azure/azure-iot-sdk-c).

Both simulations are designed to integrate with Azure IoT services for end-to-end cloud testing.

## Azure Services Tested/Testing

- **IoT Hub**  
- **IoT Central**  
- **Azure Fabric**  
- **Event Hubs**  
- **Event Stream**  
- **Stream Analytics**  
- **Data Lakehouse**  
- **Power BI**  
- **Cosmos DB**  
- **Blob Storage**  
- **Azure Monitor**  
- **Log Analytics**  
- **Logic Apps**  
- **Azure Entra ID**

## Goals

- Simulate device-to-cloud telemetry pipelines  
- Evaluate MQTT vs HTTPS transport for IoT devices  
- Visualize telemetry data in real time using Azure tools  
- Test data routing, transformation, and storage workflows  
- Monitor and analyze system behavior using Azure’s observability tools

## Lessons Learned

- **Transport Protocols**: MQTT offers low overhead and real-time streaming but requires persistent connections and broker management. HTTPS is more firewall-friendly and easier to implement in constrained environments but introduces higher latency.
- **Network Security**: Implementing SAS tokens, encrypted communication (TLS), and authentication via Azure DPS highlighted the importance of secure provisioning and credential rotation in IoT scenarios.
- **API Design & Integration**: Understanding Azure’s device and service APIs (IoT Hub, DPS, Stream Analytics, etc.) was essential for managing telemetry flow, device registration, and downstream processing.
- **Data Handling**: Stream Analytics and Event Hubs enabled real-time filtering and transformation, while Cosmos DB and Data Lakehouse offered scalable storage and retrieval capabilities.
- **Visualization & Monitoring**: Power BI and Log Analytics provided robust insights into device behavior, telemetry anomalies, and system health.
- **Simulations Accelerate Learning**: Using Node.js and Wokwi allowed rapid experimentation without needing to flash hardware repeatedly or deploy to physical devices.

---

All of this code has no ties to any enterprise and is completely of my own testing and interest. 
