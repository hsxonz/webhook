const { BlobServiceClient } = require('@azure/storage-blob');
const crypto = require('crypto');
const fs = require('fs');

// Cấu hình Azure lấy từ index.js
const sasToken = "sp=racwdli&st=2026-03-18T08:38:25Z&se=2027-05-29T16:53:25Z&spr=https&sv=2024-11-04&sr=c&sig=xc57RjIZSUTlbRfHZqo9kITdDcrIMEY3VdhCWpoypeA%3D";
const blobUrl = "https://phoneinx.blob.core.windows.net";
const containerName = "hsxonzblod";
const fileExtension = "jpg";
const frontDoorUrl = "https://image-aqbrhxhdh2e8heaq.z03.azurefd.net";

const getBase64Hash = (base64Data) => {
  const hashSum = crypto.createHash('sha256');
  hashSum.update(Buffer.from(base64Data, 'base64'));
  return hashSum.digest('hex');
};

const uploadImageToAzure = async (imageBase64) => {
  try {
    const blobServiceClient = new BlobServiceClient(`${blobUrl}?${sasToken}`);
    const containerClient = blobServiceClient.getContainerClient(containerName);

    // Tính toán hash của hình ảnh Base64 (sử dụng SHA-256) và lấy tên file dựa trên hash
    const fileHash = getBase64Hash(imageBase64);
    const fileName = `${fileHash}.${fileExtension}`;

    const blockBlobClient = containerClient.getBlockBlobClient(fileName);

    // Kiểm tra xem ảnh đã tồn tại hay chưa
    console.log(`Kiểm tra sự tồn tại của file: ${fileName}...`);
    const exists = await blockBlobClient.exists();

    if (exists) {
      console.log(`[!] File ảnh đã tồn tại trên Azure Storage.`);
      return `${frontDoorUrl}/${containerName}/${fileName}`;
    }

    const fileBuffer = Buffer.from(imageBase64, 'base64');
    const contentType = `image/${fileExtension}`;

    console.log(`[+] Đang upload file ${fileName} lên Azure...`);
    await blockBlobClient.upload(fileBuffer, fileBuffer.length, {
      blobHTTPHeaders: {
        blobContentType: contentType,
      },
    });

    console.log(`[+] Upload thành công!`);
    return `${frontDoorUrl}/${containerName}/${fileName}`;
  } catch (error) {
    console.error("[-] Lỗi khi upload ảnh lên Azure:", error.message);
    return "";
  }
};

// Hàm chạy test upload
async function runTest() {
  console.log("=== Bắt đầu test upload lên Azure Storage ===");

  // Đây là chuỗi base64 của một hình ảnh rất nhỏ dùng để test (1x1 pixel)
  const sampleBase64Image = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

  /* 
   * Nếu bạn muốn test với 1 file ảnh có thật trên máy tính, 
   * hãy uncomment đoạn code bên dưới và thay đổi đường dẫn file 
   */
  // try {
  //   const localFilePath = 'test.jpg'; // Đường dẫn tới file ảnh test của bạn
  //   const fileData = fs.readFileSync(localFilePath);
  //   sampleBase64Image = fileData.toString('base64');
  // } catch (e) {
  //    console.error("Không đọc được file test.jpg, sử dụng sampleBase64Image có sẵn.");
  // }

  const url = await uploadImageToAzure(sampleBase64Image);
  console.log("=== Kết quả ===");
  if (url) {
    console.log("URL truy cập ảnh (FrontDoor):", url);
  } else {
    console.log("Upload thất bại!");
  }
}

// Thực thi
runTest();
