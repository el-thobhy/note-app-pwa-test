namespace NoteAppPWA.Helper
{
    using Azure.Core;
    using Microsoft.AspNetCore.Http;
    using Microsoft.Extensions.Configuration;
    using NoteAppPWA.Models;
    using SixLabors.ImageSharp;
    using System.Net;
    using System.Net.Mail;
    using System.Net.Mime;
    using System.Text;

    public interface IEmailHelper
    {
        Task SendEmailWithLinkedImages(ShareEmailModel model);
    }

    public class EmailHelper : IEmailHelper
    {
        private readonly IConfiguration _configuration;
        private readonly IHttpContextAccessor _httpContextAccessor;
        private readonly IFileHelper _fileHelper;
        private readonly IWebHostEnvironment _env;
        public EmailHelper(IConfiguration configuration, IWebHostEnvironment env, IHttpContextAccessor httpContextAccessor)
        {
            _configuration = configuration;
            _env = env;
            _httpContextAccessor = httpContextAccessor;
            _fileHelper = new FileHelper(_configuration, _env);
        }
        public async Task SendEmailWithLinkedImages(ShareEmailModel model)
        {
            var emailSettings = _configuration.GetSection("EmailSettings");

            using var smtpClient = new SmtpClient(emailSettings["SmtpServer"])
            {
                Port = int.Parse(emailSettings["Port"]!),
                Credentials = new NetworkCredential(emailSettings["UserName"], emailSettings["Password"]),
                EnableSsl = true
            };

            using var mailMessage = new MailMessage
            {
                From = new MailAddress(emailSettings["FromEmail"]!),
                Subject = model.Subject,
                IsBodyHtml = true,
            };

            foreach (var mailTo in model.Email.Split(';'))
            {
                if (!string.IsNullOrEmpty(mailTo))
                    mailMessage.To.Add(mailTo);
            }

            string htmlBody = model.BodyMail;
            var doc = new HtmlAgilityPack.HtmlDocument();
            doc.LoadHtml(htmlBody);

            var imgNodes = doc.DocumentNode.SelectNodes("//img[@src]");
            List<LinkedResource> linkedResources = new();

            if (imgNodes != null)
            {
                int counter = 1;

                foreach (var imgNode in imgNodes)
                {
                    var imgSrc = imgNode.GetAttributeValue("src", null);
                    if (string.IsNullOrEmpty(imgSrc)) continue;

                    try
                    {
                        Stream? imageStream = null;

                        // CASE 1️⃣: Inline base64
                        if (imgSrc.StartsWith("data:image", StringComparison.OrdinalIgnoreCase))
                        {
                            var base64Data = imgSrc[(imgSrc.IndexOf(',') + 1)..];
                            var imageBytes = Convert.FromBase64String(base64Data);
                            imageStream = new MemoryStream(imageBytes);
                        }
                        // CASE 2️⃣: Relative Uploads path
                        else if (imgSrc.Contains("Uploads", StringComparison.OrdinalIgnoreCase))
                        {
                            var relativePart = imgSrc[imgSrc.IndexOf("Uploads", StringComparison.OrdinalIgnoreCase)..];
                            var filePath = System.Web.HttpUtility.UrlDecode(relativePart);
                            imageStream = _fileHelper.ReadFile(filePath); // from Azure or local
                        }

                        if (imageStream != null)
                        {
                            string cid = "img" + counter++;
                            var linkedImage = new LinkedResource(imageStream)
                            {
                                ContentId = cid,
                                TransferEncoding = TransferEncoding.Base64
                            };

                            linkedResources.Add(linkedImage);
                            imgNode.SetAttributeValue("src", "cid:" + cid);
                        }
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"❌ Failed to embed image {imgSrc}: {ex.Message}");
                    }
                }
            }

            // ✅ Update HTML and create final AlternateView
            htmlBody = doc.DocumentNode.OuterHtml;
            var htmlView = AlternateView.CreateAlternateViewFromString(htmlBody, Encoding.UTF8, MediaTypeNames.Text.Html);

            // Attach all LinkedResources
            foreach (var res in linkedResources)
                htmlView.LinkedResources.Add(res);

            mailMessage.AlternateViews.Add(htmlView);

            await smtpClient.SendMailAsync(mailMessage);
        }




    }
}