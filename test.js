// const { BlobServiceClient } = require('@azure/storage-blob');

// const sasToken = "sv=2022-11-02&ss=bfqt&srt=o&sp=rwdlacupiytfx&se=2025-09-29T22:26:17Z&st=2024-09-22T14:26:17Z&spr=https&sig=n%2BUyZae6g%2B2HzsJa9dwiQWgmLYyBsIdeRWH3zUy4JrM%3D"; // Thay bằng token thật
// const blobUrl = "https://phoneinx.blob.core.windows.net";
// const containerName = "hsxonzblod";
// const fileExtension = "jpg";
// const frontDoorUrl = "https://image-aqbrhxhdh2e8heaq.z03.azurefd.net";

// async function getRandomImageUrl() {
//   const serviceClient = new BlobServiceClient(`${blobUrl}?${sasToken}`);
//   const containerClient = serviceClient.getContainerClient(containerName);

//   const imageBlobs = [];
//   for await (const blob of containerClient.listBlobsFlat()) {
//     if (blob.name.toLowerCase().endsWith(`.${fileExtension}`)) {
//       imageBlobs.push(blob.name);
//     }
//   }

//   if (imageBlobs.length === 0) {
//     throw new Error("No images found in container.");
//   }

//   const randomIndex = Math.floor(Math.random() * imageBlobs.length);
//   const randomBlobName = imageBlobs[randomIndex];

//   const imageUrl = `${frontDoorUrl}/${containerName}/${randomBlobName}`;
//   return imageUrl;
// }

// // Ví dụ dùng:
// getRandomImageUrl().then(url => {
//   console.log("Random image URL:", url);
// }).catch(console.error);

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const getSession = async () => {
  let config = {
    method: 'get',
    maxBodyLength: Infinity,
    url: `http://localhost:3000/api/sessions?all=false`,
    headers: {
      'X-Api-Key': '6cfe313601805365db13bf258d0f25c42d9618be745618438ee42d3e41ea46b63d6e335477e3f91a886c0287a4c06775c1935d8985242b9cf8ccbf1e79105506'
    }
  };
  const results = await axios.request(config)
    .then((response) => {
      return {
        success: true,
        data: response.data
      };
    })
    .catch((error) => {
      console.error('Error reading messages:', error);
      return {
        success: false,
        error: error.response ? error.response.data : 'Unknown error'
      };
    });
  return results.data.filter(session => session.status === "WORKING");
}

;(async ()=>{
  let a = []
  for(let i = 0; i < 1000; i++) {
    console.time(`getSession ${i}`);
    const sessions = getSession();
    a.push(sessions)
    // console.log(sessions) 
    console.timeEnd(`getSession ${i}`);
  }

  console.time("PromiseAll");
  await Promise.all(a)
  console.timeEnd("PromiseAll");
  // console.timeEnd("getSession");
  // const sessions = await getSession();
  // // console.log(sessions) 
})()