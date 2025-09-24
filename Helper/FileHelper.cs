using Azure.Storage.Blobs;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Jpeg;
using SixLabors.ImageSharp.Processing;

namespace NoteAppPWA.Helper
{
 

    public interface IFileHelper
    {
        Task UploadFileAsync(string blobPath, Stream inputStream);
        Task<bool> FileExistsAsync(string blobPath);
        void DeleteFile(string blobPath);
        Stream ReadFile(string blobPath);
        string ConvertStreamToBase64(Stream inputStream);
    }

    public class FileHelper : IFileHelper
    {
        private readonly IConfiguration _configuration;
        private static IWebHostEnvironment _env;

        public FileHelper(IConfiguration configuration, IWebHostEnvironment env)
        {
            _configuration = configuration;
            _env = env;
        }
        public static string GetSafeFullPath(string inputPath)
        {
            if (Path.IsPathRooted(inputPath))
            {
                // Path sudah absolut
                return inputPath;
            }

            if (inputPath.Contains(".."))
            {
                throw new InvalidOperationException("Invalid relative path.");
            }

            // Sama seperti Server.MapPath("~/")
            string basePath = _env.WebRootPath ?? _env.ContentRootPath;
            return Path.Combine(basePath, inputPath);
        }

        public static MemoryStream SaveCompressedImageToStream(Stream input, int quality)
        {
            using var image = Image.Load(input);

            var maxWidth = 1920;
            var maxHeight = 1080;

            // Resize jika lebih besar
            image.Mutate(x => x.Resize(new ResizeOptions
            {
                Mode = ResizeMode.Max,
                Size = new Size(maxWidth, maxHeight)
            }));

            var outputStream = new MemoryStream();

            var encoder = new JpegEncoder
            {
                Quality = quality
            };

            image.Save(outputStream, encoder);
            outputStream.Position = 0;

            return outputStream;
        }
        public async Task UploadFileAsync(string blobPath, Stream inputStream)
        {
            var connectionString = _configuration["AzureStorage:ConnectionStrings"];
            var containerName = _configuration["AzureStorage:ContainerName"];

            BlobServiceClient blobServiceClient = new BlobServiceClient(connectionString);

            // Get a reference to the container
            BlobContainerClient containerClient = blobServiceClient.GetBlobContainerClient(containerName);

            // Create the container if it doesn't exist
            await containerClient.CreateIfNotExistsAsync();

            // Get a reference to the blob
            BlobClient blobClient = containerClient.GetBlobClient(blobPath);

            // Upload the file to Azure Blob Storage from the file stream
            await blobClient.UploadAsync(inputStream, overwrite: true);
        }

        public Stream ReadFile(string blobPath)
        {
            var connectionString = _configuration["AzureStorage:ConnectionStrings"];
            var containerName = _configuration["AzureStorage:ContainerName"];

            blobPath = GetRelativeUploadPath(blobPath);
            BlobServiceClient blobServiceClient = new BlobServiceClient(connectionString);

            // Get a reference to the container
            BlobContainerClient containerClient = blobServiceClient.GetBlobContainerClient(containerName);

            // Get a reference to the blob
            BlobClient blobClient = containerClient.GetBlobClient(blobPath);

            // Check if the blob exists
            if (!blobClient.Exists())
            {
                throw new FileNotFoundException($"File '{blobPath}' does not exist.");
            }

            // Open and return the stream of the blob
            return blobClient.OpenRead();
        }

        public string ConvertStreamToBase64(Stream inputStream)
        {
            using (MemoryStream ms = new MemoryStream())
            {
                inputStream.CopyTo(ms); // salin isi stream ke MemoryStream
                byte[] fileBytes = ms.ToArray(); // ambil byte array
                return Convert.ToBase64String(fileBytes); // konversi ke base64
            }
        }


        public void DeleteFile(string blobPath)
        {
            var connectionString = _configuration["AzureStorage:ConnectionStrings"];
            var containerName = _configuration["AzureStorage:ContainerName"];

            BlobServiceClient blobServiceClient = new BlobServiceClient(connectionString);

            // Get a reference to the container
            BlobContainerClient containerClient = blobServiceClient.GetBlobContainerClient(containerName);

            // Get a reference to the specific blob
            BlobClient blobClient = containerClient.GetBlobClient(blobPath);

            // Delete the blob if it exists
            if (blobClient.Exists())
            {
                blobClient.DeleteIfExists();
            }
        }
        public async Task<bool> FileExistsAsync(string blobPath)
        {
            var connectionString = _configuration["AzureStorage:ConnectionStrings"];
            var containerName = _configuration["AzureStorage:ContainerName"];

            blobPath = GetRelativeUploadPath(blobPath);
            BlobServiceClient blobServiceClient = new BlobServiceClient(connectionString);

            // Get a reference to the container
            BlobContainerClient containerClient = blobServiceClient.GetBlobContainerClient(containerName);

            // Get a reference to the specific blob
            BlobClient blobClient = containerClient.GetBlobClient(blobPath);

            return await blobClient.ExistsAsync();
        }
        public string GetRelativeUploadPath(string fullPath)
        {
            if (string.IsNullOrEmpty(fullPath))
                return string.Empty;

            const string keyword = "Uploads";

            // Jika sudah diawali dengan "Uploads" (case-insensitive), langsung kembalikan
            if (fullPath.StartsWith(keyword, StringComparison.OrdinalIgnoreCase))
                return fullPath.Replace("\\", "/");

            // Cari "Uploads" di tengah-tengah path
            int index = fullPath.IndexOf(keyword, StringComparison.OrdinalIgnoreCase);
            if (index < 0)
                return string.Empty;

            string relativePath = fullPath.Substring(index);
            return relativePath.Replace("\\", "/");
        }


    }


}
