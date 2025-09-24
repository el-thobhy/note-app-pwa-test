namespace NoteAppPWA.Helper
{
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

        public EmailHelper(IConfiguration configuration)
        {
            _configuration = configuration;
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
            var htmlView = AlternateView.CreateAlternateViewFromString(htmlBody, null, MediaTypeNames.Text.Html);

            // 🔹 Cari semua <img src="..."> dari HTML
            var doc = new HtmlAgilityPack.HtmlDocument();
            doc.LoadHtml(model.BodyMail);
            var imgNodes = doc.DocumentNode.SelectNodes("//img[@src]");

            if (imgNodes != null)
            {
                int counter = 1;
                using var httpClient = new HttpClient();

                foreach (var imgNode in imgNodes)
                {
                    var imgUrl = imgNode.GetAttributeValue("src", null);
                    if (string.IsNullOrEmpty(imgUrl)) continue;

                    try
                    {
                        // 🔹 Download gambar dari URL
                        var imageBytes = await httpClient.GetByteArrayAsync(imgUrl);
                        var imageStream = new MemoryStream(imageBytes);

                        string cid = "img" + counter++;
                        var linkedImage = new LinkedResource(imageStream, MediaTypeNames.Image.Jpeg)
                        {
                            ContentId = cid,
                            TransferEncoding = TransferEncoding.Base64
                        };

                        htmlView.LinkedResources.Add(linkedImage);

                        // 🔹 Replace src di HTML jadi cid:
                        imgNode.SetAttributeValue("src", "cid:" + cid);
                    }
                    catch (Exception ex)
                    {
                        System.Diagnostics.Debug.WriteLine($"Gagal ambil gambar dari {imgUrl}: {ex.Message}");
                    }
                }

                // Update htmlBody dengan <img src="cid:...">
                htmlBody = doc.DocumentNode.OuterHtml;
                htmlView = AlternateView.CreateAlternateViewFromString(htmlBody, null, MediaTypeNames.Text.Html);
            }

            mailMessage.AlternateViews.Add(htmlView);

            smtpClient.Send(mailMessage);

        }

    }
}