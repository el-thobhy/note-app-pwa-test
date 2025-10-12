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

    public interface IEmailHelper
    {
        Task SendEmailWithLinkedImages(ShareEmailModel model);
    }

    public class EmailHelper : IEmailHelper
    {
        private readonly IConfiguration _configuration;
        private readonly IHttpContextAccessor _httpContextAccessor;
        public EmailHelper(IConfiguration configuration, IHttpContextAccessor httpContextAccessor)
        {
            _configuration = configuration;
            _httpContextAccessor = httpContextAccessor;
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

            // Base HTML
            string htmlBody = model.BodyMail;
            var htmlView = AlternateView.CreateAlternateViewFromString(htmlBody, null, MediaTypeNames.Text.Html);

            // Parse <img> tags
            var doc = new HtmlAgilityPack.HtmlDocument();
            doc.LoadHtml(model.BodyMail);
            var imgNodes = doc.DocumentNode.SelectNodes("//img[@src]");

            if (imgNodes != null)
            {
                int counter = 1;
                using var httpClient = new HttpClient();

                // Get base URL (ASP.NET Core)
                var request = _httpContextAccessor.HttpContext.Request;
                var baseUrl = $"{request.Scheme}://{request.Host}";

                foreach (var imgNode in imgNodes)
                {
                    var imgSrc = imgNode.GetAttributeValue("src", null);
                    if (string.IsNullOrEmpty(imgSrc))
                        continue;

                    try
                    {
                        byte[] imageBytes;

                        // 🔹 CASE 1: Base64 inline image (data:image/jpeg;base64,...)
                        if (imgSrc.StartsWith("data:image", StringComparison.OrdinalIgnoreCase))
                        {
                            var base64Data = imgSrc.Substring(imgSrc.IndexOf(",") + 1);
                            imageBytes = Convert.FromBase64String(base64Data);
                        }
                        else
                        {
                            // 🔹 CASE 2: Relative path (no scheme)
                            if (!Uri.TryCreate(imgSrc, UriKind.Absolute, out Uri? imgUri))
                            {
                                // Append base URL
                                if (!imgSrc.StartsWith("/")) imgSrc = "/" + imgSrc;
                                imgSrc = baseUrl + imgSrc;
                            }

                            // 🔹 Download from URL
                            imageBytes = await httpClient.GetByteArrayAsync(imgSrc);
                        }

                        // 🔹 Convert to linked CID resource
                        using var imageStream = new MemoryStream(imageBytes);
                        string cid = "img" + counter++;

                        var linkedImage = new LinkedResource(imageStream)
                        {
                            ContentId = cid,
                            TransferEncoding = TransferEncoding.Base64
                        };

                        htmlView.LinkedResources.Add(linkedImage);

                        // Replace <img src="..."> with <img src="cid:...">
                        imgNode.SetAttributeValue("src", "cid:" + cid);
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"⚠️ Failed to process image {imgSrc}: {ex.Message}");
                    }
                }

                // Update HTML body with CID references
                htmlBody = doc.DocumentNode.OuterHtml;
                htmlView = AlternateView.CreateAlternateViewFromString(htmlBody, null, MediaTypeNames.Text.Html);
            }

            mailMessage.AlternateViews.Add(htmlView);

            await smtpClient.SendMailAsync(mailMessage);
        }


    }
}