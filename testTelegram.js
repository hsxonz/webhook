const axios = require("axios");
const moment = require('moment-timezone');
const getTime = ()=>{
    const currentUtcTime = moment.utc();
    const formattedUtcTime = currentUtcTime.format('YYYY-MM-DD HH:mm:ss.SSSSSS') + '+00:00';
    return formattedUtcTime;
}

const adDataServer = async (id,contactAuthor,contactGroup, message, string_url) => {
    let data = JSON.stringify([{
        "id": "8281045",
        "message": message,
        "groupName": contactGroup.name,
        "senderName": contactAuthor.pushname || contactAuthor.name,
        "senderPhone": contactAuthor.number,
        "time": getTime(),
        "image": string_url
    }]);
    let config = {
        method: 'put',
        maxBodyLength: Infinity,
        url: 'http://157.10.195.156:8815/search/v2/es/data/insert',
        headers: {
            'Content-Type': 'application/json'
        },
        data: data
    };

    return await axios.request(config)
        .then((response) => {
            console.log(JSON.stringify(response.data));
            return true;
        })
        .catch((error) => {
            console.log(error.toString()); 
            return false;
        });

}

const getGroupsInfo = async (group,session="default") =>{
  return await axios.get(`http://103.68.109.173:3000/api/${session}/groups/${group}`).then(res => {
    return {
      status : true,
      data: res.data
    }
  }).catch(err => {
    console.error(`Error fetching group info: ${err.message}`);
    return {
      status : false,
      data: null
    }
  });
}

const getContactInfo = async (contact,session="default") =>{
  return await axios.get(`http://103.68.109.173:3000/api/${session}/lids/${contact}`).then(res => {
    return {
      status : true,
      data: res.data
    }
  }).catch(err => {
    console.error(`Error fetching group info: ${err.message}`);
    return {
      status : false,
      data: null
    }
  });
}

;(async ()=>{
    
    const data = await axios.get("http://localhost:3000/api/files/default/CA550500FAF55756C64D1D439A198804.jpeg").then(res =>{
        return res.data;
    })
    console.log(data);
})()