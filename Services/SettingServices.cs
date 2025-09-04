
using Azure.Core;
using ELAuth.ViewModel;
using Newtonsoft.Json;
using System.Net.Http.Headers;
using System.Text;

namespace NoteAppPWA.Services
{
    public class SettingServices : ISettingServices
    {
        private readonly HttpClient _client;
        private readonly IHttpContextAccessor _httpContextAccessor;
        private readonly string _routeApi;



        private LoginResponseViewModel response = new LoginResponseViewModel();

        public SettingServices(IHttpClientFactory httpClientFactory, IHttpContextAccessor httpContextAccessor, IConfiguration config)
        {
            _client = httpClientFactory.CreateClient();
            _httpContextAccessor = httpContextAccessor;
            _routeApi = config["ApiUrl"]; // langsung ambil dari config DI SINI
        }

        public async Task<LoginResponseViewModel> UpdateProfilePhoto(string id, string userName, IFormFile file)
        {
            string token = _httpContextAccessor?.HttpContext?.Session.GetString("Token") ?? "";
            _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

            using var form = new MultipartFormDataContent();

            //convert IFormFile 
            using var stream = file.OpenReadStream();
            var fileContent = new StreamContent(stream);
            fileContent.Headers.ContentType = new MediaTypeHeaderValue(file.ContentType);

            form.Add(fileContent, "file", file.FileName);

            var url = $"{_routeApi}/api/Account/UploadProfilePhoto?id={id}&userName={userName}";
            HttpResponseMessage httpResponseMessage = await _client.PostAsync(url, form);
            if (httpResponseMessage.IsSuccessStatusCode)
            {
                response = JsonConvert.DeserializeObject<LoginResponseViewModel>(await httpResponseMessage.Content.ReadAsStringAsync());
            }
            else
            {
                response = JsonConvert.DeserializeObject<LoginResponseViewModel>(await httpResponseMessage.Content.ReadAsStringAsync());
            }


            return response ?? new LoginResponseViewModel();
        }
    }
}
